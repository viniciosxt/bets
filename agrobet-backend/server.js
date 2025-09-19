import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';

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
    user: { name: String, pix: String }
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

const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const preference = new Preference(client);
const payment = new Payment(client);

// --- Middleware de Autenticação do Admin ---
const authAdmin = (req, res, next) => {
    const token = req.headers.cookie?.split('; ').find(row => row.startsWith('admin_token='))?.split('=')[1];
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
app.post('/login', async (req, res) => { /* ...código inalterado... */ });
app.post('/register', async (req, res) => { /* ...código inalterado... */ });

// Rota para o front-end buscar os jogos abertos
app.get('/games', async (req, res) => {
    try {
        const openGames = await Game.find({ status: 'aberto' }).sort({ date: 1 });
        res.json(openGames);
    } catch (error) {
        res.status(500).json({ message: "Erro ao buscar jogos." });
    }
});

app.post('/criar-pagamento', async (req, res) => {
    const { gameId, title, description, unit_price, user } = req.body;
    try {
        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto') {
            return res.status(400).json({ message: 'Este jogo não está mais aberto para apostas.' });
        }
        const result = await preference.create({ /* ...código da preferência... */ });
        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) { res.status(500).send('Erro no servidor ao criar pagamento.'); }
});

app.post('/webhook-mercadopago', express.raw({ type: 'application/json' }), async (req, res) => { /* ...código do webhook... */ });
app.get('/relatorio', async (req, res) => { /* ...código do relatório... */ });
app.get('/my-bets/:pix', async (req, res) => { /* ...código das apostas do utilizador... */ });

// Rota para mostrar os resultados dos jogos finalizados
app.get('/results', async (req, res) => {
    try {
        const finishedGames = await Game.find({ status: 'finalizado' }).sort({ date: -1 });
        let html = `<h1>Resultados dos Jogos</h1><table>...`; // Geração da tabela de resultados
        finishedGames.forEach(game => {
            let winner = 'Pendente';
            if (game.result === 'home') winner = game.home.name;
            else if (game.result === 'away') winner = game.away.name;
            else if (game.result === 'empate') winner = 'Empate';
            html += `<tr><td>${game.date}</td><td>${game.home.name} vs ${game.away.name}</td><td><strong>${winner}</strong></td></tr>`;
        });
        html += `</tbody></table>`;
        res.send(html);
    } catch (error) { res.status(500).send("Erro ao gerar a página de resultados."); }
});


// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
const adminPageStyle = `<style>body{font-family: Arial; padding: 20px;} h1,h2{color:#1b5e20;} input,select,button{padding:8px;margin:5px 0;width:300px;} button{background:#1b5e20;color:white;cursor:pointer;} table{width:100%; border-collapse:collapse;margin-top:20px;} th,td{border:1px solid #ccc;padding:8px;}</style>`;

// Página de Login do Admin
app.get('/admin', (req, res) => {
    res.send(`
        ${adminPageStyle}
        <h1>Login de Administrador</h1>
        <form action="/admin/login" method="POST">
            <input type="password" name="password" placeholder="Senha" required />
            <button type="submit">Entrar</button>
        </form>
    `);
});

// Processar Login do Admin
app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
        res.cookie('admin_token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
        res.redirect('/admin/dashboard');
    } else {
        res.send('Senha incorreta. <a href="/admin">Tentar novamente</a>');
    }
});

// Dashboard do Admin
app.get('/admin/dashboard', authAdmin, async (req, res) => {
    const games = await Game.find().sort({ date: -1 });
    let gamesRows = games.map(game => `
        <tr>
            <td>${game.competition}</td>
            <td>${game.home.name} vs ${game.away.name}</td>
            <td>${game.date}</td>
            <td>
                <form action="/admin/update-game/${game._id}" method="POST" style="display:inline;">
                    <select name="status">
                        <option value="aberto" ${game.status === 'aberto' ? 'selected' : ''}>Aberto</option>
                        <option value="fechado" ${game.status === 'fechado' ? 'selected' : ''}>Fechado</option>
                        <option value="finalizado" ${game.status === 'finalizado' ? 'selected' : ''}>Finalizado</option>
                    </select>
                    <select name="result">
                        <option value="pendente" ${game.result === 'pendente' ? 'selected' : ''}>Pendente</option>
                        <option value="home" ${game.result === 'home' ? 'selected' : ''}>${game.home.name} Venceu</option>
                        <option value="away" ${game.result === 'away' ? 'selected' : ''}>${game.away.name} Venceu</option>
                        <option value="empate" ${game.result === 'empate' ? 'selected' : ''}>Empate</option>
                    </select>
                    <button type="submit">Atualizar</button>
                </form>
            </td>
        </tr>
    `).join('');

    res.send(`
        ${adminPageStyle}
        <h1>Painel de Administração</h1>
        <h2>Criar Novo Jogo</h2>
        <form action="/admin/create-game" method="POST">
            <input name="competition" placeholder="Competição" required /><br>
            <input name="homeName" placeholder="Nome Time da Casa" required /><br>
            <input name="homeLogo" placeholder="URL Logo Time da Casa" required /><br>
            <input name="awayName" placeholder="Nome Time Visitante" required /><br>
            <input name="awayLogo" placeholder="URL Logo Time Visitante" required /><br>
            <input name="date" placeholder="Data e Hora (ex: 25/12/2025 - 21:00)" required /><br>
            <button type="submit">Criar Jogo</button>
        </form>
        <h2>Jogos Existentes</h2>
        <table><tr><th>Competição</th><th>Jogo</th><th>Data</th><th>Ações</th></tr>${gamesRows}</table>
    `);
});

// Processar criação de jogo
app.post('/admin/create-game', authAdmin, async (req, res) => {
    const { competition, homeName, homeLogo, awayName, awayLogo, date } = req.body;
    const newGame = new Game({
        competition,
        home: { name: homeName, logo: homeLogo },
        away: { name: awayName, logo: awayLogo },
        date
    });
    await newGame.save();
    res.redirect('/admin/dashboard');
});

// Processar atualização de jogo
app.post('/admin/update-game/:id', authAdmin, async (req, res) => {
    const { status, result } = req.body;
    await Game.findByIdAndUpdate(req.params.id, { status, result });
    res.redirect('/admin/dashboard');
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

