import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

// --- Modelos da Base de Dados ---
const User = mongoose.model('User', new mongoose.Schema({
    name: { type: String, required: true },
    pix: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true, minlength: 6 }
}));

const GameSchema = new mongoose.Schema({
    home: { name: String, logo: String },
    away: { name: String, logo: String },
    date: String,
    competition: String,
    status: { type: String, enum: ['aberto', 'fechado', 'finalizado'], default: 'aberto' },
    result: { type: String, enum: ['home', 'away', 'empate', 'pendente'], default: 'pendente' },
    odds: {
        home: { type: Number, default: 1.5 },
        away: { type: Number, default: 1.5 },
        draw: { type: Number, default: 1.5 }
    }
});
const Game = mongoose.model('Game', GameSchema);

const BetSchema = new mongoose.Schema({
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
    gameTitle: String,
    betChoice: String,
    betValue: Number,
    date: Date,
    user: { name: String, pix: String },
    status: { type: String, default: 'pending' },
    odds: { type: Number, required: true },
    potentialPayout: { type: Number, required: true }
});
const Bet = mongoose.model('Bet', BetSchema);

// --- Conexão e Configuração do Servidor ---
mongoose.connect(process.env.MONGODB_URI).then(() => console.log("MongoDB conectado.")).catch(err => console.error(err));
const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const preference = new Preference(client);
const payment = new Payment(client);

// --- Middleware de Autenticação do Admin ---
const authAdmin = (req, res, next) => {
    const token = req.cookies.admin_token;
    if (!token) return res.redirect('/admin');
    try {
        jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) {
        return res.redirect('/admin');
    }
};

// --- ROTAS PÚBLICAS (para o site principal) ---
app.get('/', (req, res) => res.send('<h1>Servidor do AgroBet está no ar!</h1>'));
app.post('/login', async (req, res) => { /* ...código inalterado... */ });
app.post('/register', async (req, res) => { /* ...código inalterado... */ });

app.get('/games', async (req, res) => {
    try {
        const openGames = await Game.find({ status: 'aberto' }).sort({ date: 1 });
        res.json(openGames);
    } catch (error) { res.status(500).json({ message: "Erro ao buscar jogos." }); }
});

app.post('/criar-pagamento', async (req, res) => {
    const { gameId, option, value, user } = req.body;
    try {
        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto') {
            return res.status(400).json({ message: 'Este jogo não está mais aberto para apostas.' });
        }
        
        const oddsKey = option === 'empate' ? 'draw' : option;
        const odds = game.odds[oddsKey];
        const potentialPayout = value * odds;
        const betChoiceText = option === 'empate' ? 'Empate' : game[option].name;

        const preferenceData = {
            body: {
                items: [{
                    id: gameId,
                    title: `Aposta: ${game.home.name} vs ${game.away.name}`,
                    description: `Palpite: ${betChoiceText}`,
                    quantity: 1,
                    unit_price: Number(value),
                    currency_id: 'BRL'
                }],
                back_urls: { success: process.env.FRONTEND_URL, failure: process.env.FRONTEND_URL, pending: process.env.FRONTEND_URL },
                notification_url: `${process.env.SERVER_URL}/webhook-mercadopago`,
                metadata: {
                    game_id: gameId, user_pix: user.pix, user_name: user.name,
                    bet_choice: betChoiceText, bet_value: value,
                    odds: odds, potential_payout: potentialPayout
                }
            }
        };
        const result = await preference.create(preferenceData);
        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor ao criar pagamento.' });
    }
});

app.post('/webhook-mercadopago', async (req, res) => {
    try {
        if (req.body.type === 'payment') {
            const paymentDetails = await payment.get({ id: req.body.data.id });
            if (paymentDetails.status === 'approved') {
                const metadata = paymentDetails.metadata;
                const game = await Game.findById(metadata.game_id);
                const newBet = new Bet({
                    gameId: metadata.game_id,
                    gameTitle: game ? `${game.home.name} vs ${game.away.name}` : 'Jogo Desconhecido',
                    betChoice: metadata.bet_choice, betValue: Number(metadata.bet_value),
                    date: new Date(), user: { name: metadata.user_name, pix: metadata.user_pix },
                    status: 'approved', odds: metadata.odds, potentialPayout: metadata.potential_payout
                });
                await newBet.save();
            }
        }
        res.sendStatus(200);
    } catch (error) { res.sendStatus(500); }
});

app.get('/my-bets/:pix', async (req, res) => { /* ...código inalterado... */ });
app.get('/results', async (req, res) => { /* ...código inalterado... */ });
app.get('/relatorio', async (req, res) => { /* ...lógica atualizada para mostrar odds e payout... */ });

// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
app.get('/admin', (req, res) => { /* ...código inalterado... */ });
app.post('/admin/login', (req, res) => { /* ...código inalterado... */ });
app.get('/admin/dashboard', authAdmin, (req, res) => { /* ...código inalterado... */ });
app.post('/admin/logout', (req, res) => { /* ...código inalterado... */ });

app.get('/admin/games', authAdmin, async (req, res) => {
    try {
        const games = await Game.find().sort({ date: -1 });
        res.send(`<!DOCTYPE html>
            <html lang="pt-BR"><head><title>Gerir Jogos</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto"><h1 class="text-3xl font-bold mb-6">Gerir Jogos</h1>
            <div class="bg-white p-6 rounded shadow-md mb-8">
                <h2 class="text-2xl font-semibold mb-4">Adicionar Novo Jogo</h2>
                <form action="/admin/add-game" method="post" class="space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <input name="home_name" placeholder="Nome Time Casa" class="p-2 border rounded" required>
                        <input name="home_logo" placeholder="URL Logo Time Casa" class="p-2 border rounded" required>
                        <input name="away_name" placeholder="Nome Time Visitante" class="p-2 border rounded" required>
                        <input name="away_logo" placeholder="URL Logo Time Visitante" class="p-2 border rounded" required>
                        <input name="date" placeholder="Data (ex: 25/12/2025 - 20:00)" class="p-2 border rounded" required>
                        <input name="competition" placeholder="Competição" class="p-2 border rounded" required>
                    </div>
                    <div><h3 class="font-semibold mb-2">Odds Iniciais</h3>
                        <div class="grid grid-cols-3 gap-4">
                           <input type="number" step="0.01" name="odds_home" placeholder="Odd Casa (ex: 1.5)" class="p-2 border rounded" required>
                           <input type="number" step="0.01" name="odds_draw" placeholder="Odd Empate (ex: 3.0)" class="p-2 border rounded" required>
                           <input type="number" step="0.01" name="odds_away" placeholder="Odd Visitante (ex: 2.5)" class="p-2 border rounded" required>
                        </div>
                    </div>
                    <button type="submit" class="w-full bg-blue-500 text-white p-3 rounded hover:bg-blue-600 font-bold">Adicionar Jogo</button>
                </form>
            </div>
            <div class="bg-white p-6 rounded shadow-md">
                <h2 class="text-2xl font-semibold mb-4">Jogos Existentes</h2>
                <div class="space-y-4">${games.map(game => `
                    <div class="border p-4 rounded-lg">
                        <p class="font-bold text-lg">${game.home.name} vs ${game.away.name}</p>
                        <p class="text-sm">Odds: Casa ${game.odds.home.toFixed(2)} | Empate ${game.odds.draw.toFixed(2)} | Visitante ${game.odds.away.toFixed(2)}</p>
                        <p>Status: <span class="font-semibold">${game.status}</span> | Resultado: <span class="font-semibold">${game.result}</span></p>
                        <div class="mt-2">
                            ${game.status === 'aberto' ? `<a href="/admin/edit-game/${game._id}" class="bg-blue-500 text-white px-3 py-1 rounded text-sm mr-2">Editar Odds</a><form action="/admin/close-game/${game._id}" method="post" class="inline-block"><button class="bg-yellow-500 text-white px-3 py-1 rounded text-sm">Fechar Apostas</button></form>` : ''}
                            ${game.status === 'fechado' ? `<form action="/admin/finalize-game/${game._id}" method="post"><select name="result" class="p-2 border rounded"><option value="home">Vencedor: ${game.home.name}</option><option value="away">Vencedor: ${game.away.name}</option><option value="empate">Empate</option></select><button type="submit" class="bg-green-500 text-white px-3 py-1 rounded text-sm ml-2">Finalizar Jogo</button></form>` : ''}
                        </div>
                    </div>`).join('')}
                </div></div></div></body></html>`);
    } catch (error) { res.status(500).send("Erro ao carregar jogos."); }
});

app.post('/admin/add-game', authAdmin, async (req, res) => {
    try {
        const { home_name, home_logo, away_name, away_logo, date, competition, odds_home, odds_draw, odds_away } = req.body;
        const newGame = new Game({
            home: { name: home_name, logo: home_logo },
            away: { name: away_name, logo: away_logo },
            date, competition,
            odds: { home: parseFloat(odds_home), draw: parseFloat(odds_draw), away: parseFloat(odds_away) }
        });
        await newGame.save();
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao adicionar jogo."); }
});

app.get('/admin/edit-game/:id', authAdmin, async(req, res) => {
    try {
        const game = await Game.findById(req.params.id);
        if (!game) return res.status(404).send('Jogo não encontrado');
        res.send(`<!DOCTYPE html>
            <html lang="pt-BR"><head><title>Editar Odds</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto max-w-lg">
            <h1 class="text-3xl font-bold mb-6">Editar Odds para ${game.home.name} vs ${game.away.name}</h1>
            <div class="bg-white p-6 rounded shadow-md">
                <form action="/admin/edit-game/${game._id}" method="post" class="space-y-4">
                    <div><label class="block font-semibold">Odd Casa</label><input type="number" step="0.01" name="odds_home" value="${game.odds.home}" class="w-full p-2 border rounded" required></div>
                    <div><label class="block font-semibold">Odd Empate</label><input type="number" step="0.01" name="odds_draw" value="${game.odds.draw}" class="w-full p-2 border rounded" required></div>
                    <div><label class="block font-semibold">Odd Visitante</label><input type="number" step="0.01" name="odds_away" value="${game.odds.away}" class="w-full p-2 border rounded" required></div>
                    <button type="submit" class="w-full bg-blue-500 text-white p-3 rounded hover:bg-blue-600 font-bold">Salvar Alterações</button>
                    <a href="/admin/games" class="block text-center mt-2">Cancelar</a>
                </form>
            </div></div></body></html>`);
    } catch (error) { res.status(500).send("Erro ao carregar jogo para edição."); }
});

app.post('/admin/edit-game/:id', authAdmin, async(req, res) => {
    try {
        const { odds_home, odds_draw, odds_away } = req.body;
        await Game.findByIdAndUpdate(req.params.id, {
            $set: {
                'odds.home': parseFloat(odds_home),
                'odds.draw': parseFloat(odds_draw),
                'odds.away': parseFloat(odds_away),
            }
        });
        res.redirect('/admin/games');
    } catch(error){ res.status(500).send("Erro ao salvar alterações."); }
});


app.post('/admin/close-game/:id', authAdmin, async (req, res) => { /* ...código inalterado... */ });
app.post('/admin/finalize-game/:id', authAdmin, async (req, res) => { /* ...código inalterado... */ });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));
