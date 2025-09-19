import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser'; // Necessário para ler os cookies do admin

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
    status: { type: String, enum: ['aberto', 'fechado', 'finalizado'], default: 'aberto' },
    result: { type: String, enum: ['home', 'away', 'empate', 'pendente'], default: 'pendente' }
});
const Game = mongoose.model('Game', GameSchema);

const BetSchema = new mongoose.Schema({
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
    gameTitle: String,
    betChoice: String,
    betValue: Number,
    date: Date,
    user: { name: String, pix: String },
    status: { type: String, default: 'pending' } // Adicionado para webhook
});
const Bet = mongoose.model('Bet', BetSchema);

// --- Conexão à Base de Dados ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Conexão com MongoDB estabelecida com sucesso."))
    .catch(err => console.error("Erro ao conectar com MongoDB:", err));

// --- Configuração do Servidor ---
const app = express();
app.use(cors());
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

// --- ROTAS PÚBLICAS ---
app.get('/', (req, res) => res.send('<h1>Servidor do AgroBet está no ar!</h1>'));

app.post('/login', async (req, res) => {
    try {
        const { pix, password } = req.body;
        const user = await User.findOne({ pix });
        if (!user) return res.json({ success: false, message: 'Utilizador não encontrado.' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.json({ success: false, message: 'Senha incorreta.' });
        res.json({ success: true, user: { name: user.name, pix: user.pix } });
    } catch (error) { res.status(500).json({ success: false, message: 'Erro no servidor.' }); }
});

app.post('/register', async (req, res) => {
    try {
        const { name, pix, password } = req.body;
        let user = await User.findOne({ pix });
        if (user) return res.json({ success: false, message: 'Esta chave PIX já está registada.' });
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
    const { gameId, title, description, unit_price, user } = req.body;
    try {
        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto') {
            return res.status(400).json({ message: 'Este jogo não está mais aberto para apostas.' });
        }
        
        const preferenceData = {
            body: {
                items: [{
                    id: gameId, title, description,
                    quantity: 1, unit_price: Number(unit_price), currency_id: 'BRL',
                }],
                back_urls: {
                    success: `${process.env.FRONTEND_URL || 'https://viniciosxt.github.io/bets/'}`,
                    failure: `${process.env.FRONTEND_URL || 'https://viniciosxt.github.io/bets/'}`,
                    pending: `${process.env.FRONTEND_URL || 'https://viniciosxt.github.io/bets/'}`
                },
                notification_url: `${process.env.SERVER_URL}/webhook-mercadopago`,
                metadata: {
                    game_id: gameId,
                    user_pix: user.pix,
                    bet_choice: description.replace('Palpite: ', ''),
                    bet_value: unit_price,
                    user_name: user.name
                }
            }
        };
        const result = await preference.create(preferenceData);
        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) {
        console.error("!!! ERRO CRÍTICO AO CRIAR PAGAMENTO:", error);
        res.status(500).json({ message: 'Erro interno no servidor ao tentar criar o pagamento.' });
    }
});

app.post('/webhook-mercadopago', async (req, res) => {
    try {
        const { body } = req;
        if (body.type === 'payment') {
            const paymentDetails = await payment.get({ id: body.data.id });
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
                    status: 'approved'
                });
                await newBet.save();
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("Erro no webhook:", error);
        res.sendStatus(500);
    }
});

app.get('/relatorio', async (req, res) => {
    try {
        const bets = await Bet.find({ status: 'approved' }).sort({ date: -1 });
        let html = `...`; // Estilos e cabeçalho da tabela
        bets.forEach(bet => {
            html += `<tr><td>${new Date(bet.date).toLocaleString('pt-BR')}</td><td>${bet.user.name}</td><td>${bet.user.pix}</td><td>${bet.gameTitle}</td><td>${bet.betChoice}</td><td>R$ ${bet.betValue.toFixed(2)}</td></tr>`;
        });
        html += `</tbody></table>`;
        res.send(html);
    } catch (error) { res.status(500).send("Erro ao gerar o relatório."); }
});

app.get('/my-bets/:pix', async (req, res) => {
    try {
        const bets = await Bet.find({ 'user.pix': req.params.pix, status: 'approved' }).sort({ date: -1 });
        res.json({ success: true, bets });
    } catch (error) { res.json({ success: false, message: 'Erro ao buscar apostas.' }); }
});

app.get('/results', async (req, res) => { /* ...código inalterado... */ });

// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
// ... código do painel de administração inalterado ...

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

