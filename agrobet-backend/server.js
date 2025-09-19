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
const VIGORISH = 0.05; // 5% de margem de lucro para a casa

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
const authAdmin = (req, res, next) => { /* ...código inalterado... */ };

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
    const { gameId, option, value } = req.body;
    try {
        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto') {
            return res.status(400).json({ message: 'Este jogo não está mais aberto para apostas.' });
        }
        
        const odds = game.odds[option === 'empate' ? 'draw' : option];
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
                back_urls: { success: process.env.FRONTEND_URL, failure: process.env.FRONTEND_URL },
                notification_url: `${process.env.SERVER_URL}/webhook-mercadopago`,
                metadata: {
                    game_id: gameId,
                    user_pix: req.body.user.pix,
                    user_name: req.body.user.name,
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
        // HTML da página de gestão de jogos agora inclui campos de probabilidade
        res.send(`...`); 
    } catch (error) { res.status(500).send("Erro ao carregar jogos."); }
});

app.post('/admin/add-game', authAdmin, async (req, res) => {
    try {
        const { home_name, home_logo, away_name, away_logo, date, competition, prob_home, prob_draw, prob_away } = req.body;
        
        const p_home = parseFloat(prob_home);
        const p_draw = parseFloat(prob_draw);
        const p_away = parseFloat(prob_away);

        if (p_home + p_draw + p_away !== 100) {
            return res.status(400).send("A soma das probabilidades deve ser 100%.");
        }

        // Calcular odds com base nas probabilidades e na margem (VIG)
        const totalProbWithVig = (p_home / 100) + (p_draw / 100) + (p_away / 100) + VIGORISH;
        const odds_home = (totalProbWithVig / (p_home / 100)).toFixed(2);
        const odds_draw = (totalProbWithVig / (p_draw / 100)).toFixed(2);
        const odds_away = (totalProbWithVig / (p_away / 100)).toFixed(2);

        const newGame = new Game({
            home: { name: home_name, logo: home_logo },
            away: { name: away_name, logo: away_logo },
            date, competition,
            odds: { home: odds_home, draw: odds_draw, away: odds_away }
        });
        await newGame.save();
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao adicionar jogo."); }
});

app.post('/admin/close-game/:id', authAdmin, async (req, res) => { /* ...código inalterado... */ });
app.post('/admin/finalize-game/:id', authAdmin, async (req, res) => { /* ...código inalterado... */ });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

