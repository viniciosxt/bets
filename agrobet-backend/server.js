import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

// --- Constante de Configuração ---
const VIGORISH = 0.10; // 10% de margem de lucro para a casa

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
        home: { type: Number, default: 1 },
        away: { type: Number, default: 1 },
        draw: { type: Number, default: 1 }
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

app.post('/login', async (req, res) => {
    try {
        const { pix, password } = req.body;
        const user = await User.findOne({ pix });
        if (!user) return res.status(404).json({ success: false, message: 'Utilizador não encontrado.' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ success: false, message: 'Senha incorreta.' });
        res.json({ success: true, user: { name: user.name, pix: user.pix } });
    } catch (error) { res.status(500).json({ success: false, message: 'Erro no servidor.' }); }
});

app.post('/register', async (req, res) => {
    try {
        const { name, pix, password } = req.body;
        let user = await User.findOne({ pix });
        if (user) return res.status(400).json({ success: false, message: 'Esta chave PIX já está registada.' });
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        user = new User({ name, pix, password: hashedPassword });
        await user.save();
        res.json({ success: true, user: { name: user.name, pix: user.pix } });
    } catch (error) { res.status(500).json({ success: false, message: 'Erro no servidor.' }); }
});


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
                    game_id: gameId,
                    user_pix: user.pix,
                    user_name: user.name,
                    bet_choice: betChoiceText,
                    bet_value: value,
                    odds: odds,
                    potential_payout: potentialPayout
                }
            }
        };
        const result = await preference.create(preferenceData);
        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) {
        console.error("ERRO AO CRIAR PAGAMENTO:", error);
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
                    betChoice: metadata.bet_choice,
                    betValue: Number(metadata.bet_value),
                    date: new Date(),
                    user: { name: metadata.user_name, pix: metadata.user_pix },
                    status: 'approved',
                    odds: metadata.odds,
                    potentialPayout: metadata.potential_payout
                });
                await newBet.save();
            }
        }
        res.sendStatus(200);
    } catch (error) { console.error("Erro no webhook:", error); res.sendStatus(500); }
});

app.get('/my-bets/:pix', async (req, res) => {
    try {
        const bets = await Bet.find({ 'user.pix': req.params.pix, status: 'approved' }).sort({ date: -1 });
        res.json({ success: true, bets });
    } catch (error) { res.json({ success: false, message: 'Erro ao buscar apostas.' }); }
});

app.get('/results', async (req, res) => {
    try {
        const finishedGames = await Game.find({ status: 'finalizado' }).sort({ date: -1 });
        res.json(finishedGames);
    } catch (error) { res.status(500).json({ message: "Erro ao buscar resultados." }); }
});

app.get('/relatorio', async (req, res) => {
    try {
        const bets = await Bet.find({ status: 'approved' }).sort({ date: -1 });
        let html = `
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório de Apostas</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto bg-white p-6 rounded-lg shadow-md">
            <h1 class="text-3xl font-bold mb-6 text-gray-800">Relatório de Apostas Confirmadas</h1><div class="overflow-x-auto">
            <table class="min-w-full bg-white"><thead class="bg-gray-800 text-white">
            <tr><th class="py-3 px-4 text-left">Data</th><th class="py-3 px-4 text-left">Utilizador</th><th class="py-3 px-4 text-left">Jogo</th><th class="py-3 px-4 text-left">Palpite</th><th class="py-3 px-4 text-left">Valor</th><th class="py-3 px-4 text-left">Odd</th><th class="py-3 px-4 text-left">Retorno Pot.</th></tr>
            </thead><tbody>`;
        bets.forEach(bet => {
            html += `<tr class="border-b"><td class="py-3 px-4">${new Date(bet.date).toLocaleString('pt-BR')}</td><td class="py-3 px-4">${bet.user.name}</td><td class="py-3 px-4">${bet.gameTitle}</td><td class="py-3 px-4">${bet.betChoice}</td><td class="py-3 px-4">R$ ${bet.betValue.toFixed(2)}</td><td class="py-3 px-4">${bet.odds.toFixed(2)}</td><td class="py-3 px-4 font-semibold text-green-700">R$ ${bet.potentialPayout.toFixed(2)}</td></tr>`;
        });
        html += `</tbody></table></div></div></body></html>`;
        res.send(html);
    } catch (error) { console.error("Erro ao gerar relatório:", error); res.status(500).send("Erro ao gerar o relatório."); }
});

// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Admin Login</title><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-gray-200 min-h-screen flex items-center justify-center">
        <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-sm">
        <h1 class="text-2xl font-bold mb-6 text-center">Login de Administrador</h1>
        <form action="/admin/login" method="post">
        <input type="password" name="password" placeholder="Senha" class="w-full p-2 border rounded mb-4" required>
        <button type="submit" class="w-full bg-blue-500 text-white p-2 rounded hover:bg-blue-600">Entrar</button>
        </form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.cookie('admin_token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 3600000 });
        res.redirect('/admin/dashboard');
    } else {
        res.send('<h1>Senha incorreta.</h1><a href="/admin">Tentar novamente</a>');
    }
});

app.get('/admin/dashboard', authAdmin, (req, res) => {
    res.send(`
        <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Painel de Administração</title><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-gray-200 min-h-screen flex items-center justify-center"><div class="container mx-auto p-8 bg-white rounded-lg shadow-lg max-w-2xl text-center">
        <h1 class="text-4xl font-bold mb-8 text-gray-800">Painel de Administração</h1><div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <a href="/admin/games" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105">Gerir Jogos</a>
        <a href="/relatorio" target="_blank" class="bg-green-500 hover:bg-green-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105">Ver Relatório de Apostas</a>
        </div><form action="/admin/logout" method="post" class="mt-8"><button type="submit" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-6 rounded-lg">Sair</button></form>
        </div></body></html>`);
});

app.post('/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin');
});

app.get('/admin/games', authAdmin, async (req, res) => {
    try {
        const games = await Game.find().sort({ date: -1 });
        res.send(`<!DOCTYPE html><html lang="pt-BR"><head><title>Gerir Jogos</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto"><h1 class="text-3xl font-bold mb-6">Gerir Jogos</h1>
            <div class="bg-white p-6 rounded shadow-md mb-8">
                <h2 class="text-2xl font-semibold mb-4">Adicionar Novo Jogo</h2>
                <form action="/admin/add-game" method="post" class="space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <input name="home_name" placeholder="Nome Time Casa" class="p-2 border rounded" required>
                        <input name="home_logo" placeholder="URL Logo Time Casa" class="p-2 border rounded" required>
                        <input name="away_name" placeholder="Nome Time Visitante" class="p-2 border rounded" required>
                        <input name="away_logo" placeholder="URL Logo Time Visitante" class="p-2 border rounded" required>
                        <input name="date" placeholder="Data e Hora (ex: 25/12/2025 - 20:00)" class="p-2 border rounded" required>
                        <input name="competition" placeholder="Competição" class="p-2 border rounded" required>
                    </div>
                    <div>
                        <h3 class="font-semibold mb-2">Probabilidades (%) - A soma deve ser 100</h3>
                        <div class="grid grid-cols-3 gap-4">
                           <input type="number" name="prob_home" placeholder="Casa %" class="p-2 border rounded" required>
                           <input type="number" name="prob_draw" placeholder="Empate %" class="p-2 border rounded" required>
                           <input type="number" name="prob_away" placeholder="Visitante %" class="p-2 border rounded" required>
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
                        ${game.status === 'aberto' ? `<form action="/admin/close-game/${game._id}" method="post" class="inline-block"><button class="bg-yellow-500 text-white px-3 py-1 rounded text-sm mt-2">Fechar Apostas</button></form>` : ''}
                        ${game.status === 'fechado' ? `<form action="/admin/finalize-game/${game._id}" method="post" class="mt-2"><select name="result" class="p-2 border rounded"><option value="home">Vencedor: ${game.home.name}</option><option value="away">Vencedor: ${game.away.name}</option><option value="empate">Empate</option></select><button type="submit" class="bg-green-500 text-white px-3 py-1 rounded text-sm ml-2">Finalizar Jogo</button></form>` : ''}
                    </div>`).join('')}
                </div></div></div></body></html>`);
    } catch (error) { res.status(500).send("Erro ao carregar jogos."); }
});

app.post('/admin/add-game', authAdmin, async (req, res) => {
    try {
        const { home_name, home_logo, away_name, away_logo, date, competition, prob_home, prob_draw, prob_away } = req.body;
        const p_home = parseFloat(prob_home);
        const p_draw = parseFloat(prob_draw);
        const p_away = parseFloat(prob_away);

        if (Math.abs(p_home + p_draw + p_away - 100) > 0.01) {
            return res.status(400).send("Erro: A soma das probabilidades deve ser exatamente 100%.");
        }

        const implied_home = p_home / 100;
        const implied_draw = p_draw / 100;
        const implied_away = p_away / 100;
        
        const total_implied = implied_home + implied_draw + implied_away;
        const odds_home = (1 / (implied_home * (1 - VIGORISH))).toFixed(2);
        const odds_draw = (1 / (implied_draw * (1 - VIGORISH))).toFixed(2);
        const odds_away = (1 / (implied_away * (1 - VIGORISH))).toFixed(2);

        const newGame = new Game({
            home: { name: home_name, logo: home_logo },
            away: { name: away_name, logo: away_logo },
            date, competition,
            odds: { home: odds_home, draw: odds_draw, away: odds_away }
        });
        await newGame.save();
        res.redirect('/admin/games');
    } catch (error) {
        console.error("Erro ao adicionar jogo:", error);
        res.status(500).send("Erro ao adicionar jogo.");
    }
});

app.post('/admin/close-game/:id', authAdmin, async (req, res) => {
    try {
        await Game.findByIdAndUpdate(req.params.id, { status: 'fechado' });
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao fechar jogo."); }
});

app.post('/admin/finalize-game/:id', authAdmin, async (req, res) => {
    try {
        await Game.findByIdAndUpdate(req.params.id, { status: 'finalizado', result: req.body.result });
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao finalizar jogo."); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

