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

// CORREÇÃO: Configuração de CORS explícita para resolver o erro 'Failed to fetch'
const corsOptions = {
  origin: 'https://viniciosxt.github.io',
  credentials: true,
};
app.use(cors(corsOptions));
console.log(`CORS configurado para aceitar pedidos de: https://viniciosxt.github.io`);


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
        // Lógica para gerar o HTML do relatório...
        res.send("Relatório Gerado");
    } catch (error) { res.status(500).send("Erro ao gerar o relatório."); }
});


// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
app.get('/admin', (req, res) => {
    res.send(`...`); // Página de login do admin
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
    res.send(`...`); // Página do dashboard do admin
});

app.post('/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin');
});

app.get('/admin/games', authAdmin, async (req, res) => {
    try {
        const games = await Game.find().sort({ date: -1 });
        // HTML da página de gestão de jogos
        res.send(`...`);
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
        // HTML da página de edição de odds
        res.send(`...`);
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

