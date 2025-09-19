import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import bodyParser from 'body-parser';
import mercadopago from 'mercadopago';
import { fileURLToPath } from 'url';

// --- Configuração Inicial para ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// --- Configuração do App ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Substitua com o seu Access Token REAL
mercadopago.configure({
    access_token: 'SEU_ACCESS_TOKEN_REAL_AQUI' 
});

// --- Funções Auxiliares para a Base de Dados ---
function initializeDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ jogos: [], apostas: [], admin: { user: 'admin', pass: 'admin123' } }, null, 2));
    } else {
        try {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            if (!data.jogos) data.jogos = [];
            if (!data.apostas) data.apostas = [];
            if (!data.admin) data.admin = { user: 'admin', pass: 'admin123' };
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        } catch (error) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ jogos: [], apostas: [], admin: { user: 'admin', pass: 'admin123' } }, null, 2));
        }
    }
}

// --- Rotas da API ---
app.get('/jogos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        const activeGames = data.jogos.filter(j => j.status === 'ativo');
        res.json(activeGames);
    } catch (error) {
        console.error("Erro ao ler /jogos:", error);
        res.status(500).json({ error: 'Erro ao ler a base de dados.' });
    }
});

app.post('/create-payment', async (req, res) => {
    const { gameId, type, amount, choice, userName, userPix } = req.body;

    if (!gameId || !type || !amount || !choice || !userName || !userPix) {
        return res.status(400).json({ error: 'Dados da aposta incompletos.' });
    }

    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    const game = data.jogos.find(j => j.id === gameId);
    if (!game || game.status !== 'ativo') {
        return res.status(400).json({ error: 'Jogo não encontrado ou não está mais ativo.' });
    }
    
    const apostaId = `aposta-${Date.now()}`;

    const newBet = { id: apostaId, gameId, type, amount, choice, userName, userPix, status: 'pendente' };
    data.apostas.push(newBet);
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

    const preference = {
        items: [{
            title: `Aposta em ${game.time_a} vs ${game.time_b}`,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: amount
        }],
        back_urls: { success: `https://viniciosxt.github.io/bets/`, failure: `https://viniciosxt.github.io/bets/` },
        auto_return: 'approved',
        external_reference: apostaId,
    };

    try {
        const response = await mercadopago.preferences.create(preference);
        res.json({ init_point: response.body.init_point });
    } catch (error) {
        console.error("Erro ao criar preferência no Mercado Pago:", error);
        res.status(500).json({ error: 'Falha ao comunicar com o sistema de pagamento.' });
    }
});

// --- Rotas do Admin ---
app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="pt-br"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{font-family:sans-serif;background:#2c2c2c;color:#f0f0f0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.login-container{background:#333;padding:40px;border-radius:10px;box-shadow:0 4px 15px rgba(0,0,0,0.5);text-align:center;width:90%;max-width:400px}h1{color:#4CAF50}input{width:100%;padding:12px;margin:10px 0;border-radius:5px;border:1px solid #555;background:#444;color:#f0f0f0;box-sizing:border-box}button{background:#4CAF50;color:white;padding:12px 20px;border:none;border-radius:5px;cursor:pointer;font-size:16px;width:100%}button:hover{background:#45a049}</style></head><body><div class="login-container"><h1>Login do Administrador</h1><form action="/admin/login" method="POST"><input type="text" name="username" placeholder="Usuário" required><input type="password" name="password" placeholder="Senha" required><button type="submit">Entrar</button></form></div></body></html>`);
});

app.post('/admin/login', bodyParser.urlencoded({ extended: false }), (req, res) => {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    const { username, password } = req.body;
    if (username === data.admin.user && password === data.admin.pass) {
        res.redirect('/admin/dashboard');
    } else {
        res.send('Usuário ou senha inválidos. <a href="/admin">Tentar novamente</a>');
    }
});

app.get('/admin/dashboard', (req, res) => {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    const activeGamesList = data.jogos.filter(j => j.status === 'ativo').map(game => `<li><span>${game.time_a} vs ${game.time_b}</span><form action="/admin/game/finish" method="POST" class="finish-form"><input type="hidden" name="gameId" value="${game.id}"><input type="text" name="placar" placeholder="Placar (ex: 2x1)" required><button type="submit">Finalizar</button></form></li>`).join('');
    res.send(`<!DOCTYPE html><html lang="pt-br"><head><title>Admin Dashboard</title><style>body{font-family:sans-serif;background:#2c2c2c;color:#f0f0f0;margin:0;padding:20px}.container{max-width:900px;margin:auto;background:#333;padding:25px;border-radius:10px}h1,h2{color:#4CAF50;border-bottom:2px solid #4CAF50;padding-bottom:10px}ul{list-style:none;padding:0}li{background:#444;padding:15px;margin-bottom:10px;border-radius:5px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap}form{margin-top:25px;background:#444;padding:20px;border-radius:8px}input[type="text"],input[type="url"]{width:calc(50% - 20px);padding:10px;margin:5px;border-radius:4px;border:1px solid #555;background:#555;color:#f0f0f0}button{background:#4CAF50;color:white;padding:10px 15px;border:none;border-radius:5px;cursor:pointer;width:100%;margin-top:10px}button:hover{background:#45a049}.finish-form{margin:0;padding:0;background:none}.finish-form input{width:auto}.finish-form button{width:auto;margin:0;background:#e74c3c}.finish-form button:hover{background:#c0392b}</style></head><body><div class="container"><h1>Painel de Administração</h1><h2>Criar Novo Jogo</h2><form action="/admin/game/create" method="POST"><input type="text" name="time_a" placeholder="Nome Time A" required><input type="url" name="logo_a" placeholder="URL Logo A" required><input type="text" name="time_b" placeholder="Nome Time B" required><input type="url" name="logo_b" placeholder="URL Logo B" required><button type="submit">Criar Jogo</button></form><h2>Jogos Ativos</h2><ul>${activeGamesList||"<li>Nenhum jogo ativo.</li>"}</ul></div></body></html>`);
});

app.post('/admin/game/create', bodyParser.urlencoded({ extended: false }), (req, res) => {
    const { time_a, logo_a, time_b, logo_b } = req.body;
    if (!time_a || !logo_a || !time_b || !logo_b) {
        return res.status(400).send('Todos os campos são obrigatórios.');
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    const newGame = { id: `game-${Date.now()}`, time_a, logo_a, time_b, logo_b, status: 'ativo', resultado: null };
    data.jogos.push(newGame);
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    res.redirect('/admin/dashboard');
});

app.post('/admin/game/finish', bodyParser.urlencoded({ extended: false }), (req, res) => {
    const { gameId, placar } = req.body;
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    const game = data.jogos.find(j => j.id === gameId);
    if (game) {
        game.status = 'finalizado';
        game.resultado = placar;
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    res.redirect('/admin/dashboard');
});


// --- Inicialização do Servidor ---
app.listen(PORT, () => {
    initializeDatabase();
    console.log(`Servidor do AgroBet está no ar na porta ${PORT}`);
});

