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
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    pix: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true, minlength: 6 }
});
const User = mongoose.model('User', UserSchema);

const GameSchema = new mongoose.Schema({
    home: { name: String, logo: String },
    away: { name: String, logo: String },
    date: String,
    competition: String,
    players: [String],
    status: { type: String, enum: ['aberto', 'fechado', 'finalizado'], default: 'aberto' },
    result: { type: String, enum: ['home', 'away', 'empate', 'pendente'], default: 'pendente' },
    finalScore: { home: Number, away: Number },
    bestPlayerResult: String,
});
const Game = mongoose.model('Game', GameSchema);

const BetSchema = new mongoose.Schema({
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
    gameTitle: String,
    betType: { type: String, required: true, enum: ['vitoria', 'placar', 'melhor_jogador'] },
    betChoice: { type: String, required: true },
    betValue: Number,
    date: Date,
    user: { name: String, pix: String },
    status: { type: String, default: 'pending' } // 'approved' após pagamento
});
const Bet = mongoose.model('Bet', BetSchema);

// --- Conexão à Base de Dados ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Conexão com MongoDB estabelecida com sucesso."))
    .catch(err => console.error("Erro ao conectar com MongoDB:", err));

// --- Configuração do Servidor ---
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
app.post('/login', async (req, res) => { /* ... (código inalterado) ... */ });
app.post('/register', async (req, res) => { /* ... (código inalterado) ... */ });

app.get('/games', async (req, res) => {
    try {
        const openGames = await Game.find({ status: 'aberto' }).sort({ date: 1 });
        res.json(openGames);
    } catch (error) { res.status(500).json({ message: "Erro ao buscar jogos." }); }
});

app.post('/criar-pagamento', async (req, res) => {
    const { gameId, betType, betChoice, unit_price, user } = req.body;
    try {
        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto') {
            return res.status(400).json({ message: 'Este jogo não está mais aberto para apostas.' });
        }

        const title = `Aposta em ${game.home.name} vs ${game.away.name}`;
        const description = `Tipo: ${betType} - Palpite: ${betChoice}`;

        const preferenceData = {
            body: {
                items: [{ id: gameId, title, description, quantity: 1, unit_price: Number(unit_price), currency_id: 'BRL' }],
                back_urls: { success: process.env.FRONTEND_URL, failure: process.env.FRONTEND_URL, pending: process.env.FRONTEND_URL },
                notification_url: `${process.env.SERVER_URL}/webhook-mercadopago`,
                metadata: { game_id: gameId, user_pix: user.pix, user_name: user.name, bet_type: betType, bet_choice: betChoice, bet_value: unit_price }
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
                    betType: metadata.bet_type,
                    betChoice: metadata.bet_choice,
                    betValue: Number(metadata.bet_value),
                    date: new Date(),
                    user: { name: metadata.user_name, pix: metadata.user_pix },
                    status: 'approved'
                });
                await newBet.save();
            }
        }
        res.sendStatus(200);
    } catch (error) { console.error("Erro no webhook:", error); res.sendStatus(500); }
});

app.get('/my-bets/:pix', async (req, res) => { /* ... (código inalterado) ... */ });
app.get('/results', async (req, res) => { /* ... (código inalterado) ... */ });

// --- ROTA DO RELATÓRIO PÚBLICO ---
app.get('/relatorio', async (req, res) => {
    try {
        const bets = await Bet.find({ status: 'approved' }).populate('gameId').sort({ date: -1 });
        // ... (código da página HTML do relatório) ...
    } catch (error) { res.status(500).send("Erro ao gerar o relatório."); }
});


// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
app.get('/admin', (req, res) => { /* ... (página de login do admin) ... */ });
app.post('/admin/login', (req, res) => { /* ... (lógica de login do admin) ... */ });
app.get('/admin/dashboard', authAdmin, (req, res) => { /* ... (página do dashboard) ... */ });
app.post('/admin/logout', (req, res) => { /* ... (lógica de logout) ... */ });

app.get('/admin/games', authAdmin, async (req, res) => {
    const games = await Game.find().sort({ date: -1 });
    // ... (página HTML de Gerir Jogos) ...
});

app.post('/admin/add-game', authAdmin, async (req, res) => {
    const { homeName, homeLogo, awayName, awayLogo, date, competition, players } = req.body;
    const game = new Game({
        home: { name: homeName, logo: homeLogo },
        away: { name: awayName, logo: awayLogo },
        date, competition,
        players: players ? players.split(',').map(p => p.trim()) : []
    });
    await game.save();
    res.redirect('/admin/games');
});

app.post('/admin/close-game/:id', authAdmin, async (req, res) => { /* ... (código inalterado) ... */ });

app.post('/admin/finalize-game/:id', authAdmin, async (req, res) => {
    const { scoreHome, scoreAway, bestPlayer } = req.body;
    const game = await Game.findById(req.params.id);
    if (game) {
        game.finalScore = { home: scoreHome, away: scoreAway };
        game.bestPlayerResult = bestPlayer;
        if (scoreHome > scoreAway) game.result = 'home';
        else if (scoreAway > scoreHome) game.result = 'away';
        else game.result = 'empate';
        game.status = 'finalizado';
        await game.save();
    }
    res.redirect('/admin/games');
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

