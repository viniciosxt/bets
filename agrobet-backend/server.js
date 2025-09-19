const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// --- Configuração ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // Para servir ficheiros estáticos como CSS, se necessário

// Configure as suas credenciais do Mercado Pago
// Substitua com o seu Access Token REAL
mercadopago.configure({
    access_token: 'SEU_ACCESS_TOKEN_REAL_AQUI' 
});

// --- Funções Auxiliares para a Base de Dados ---

// Função para garantir que o db.json existe e tem a estrutura base
function initializeDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ jogos: [], apostas: [], admin: { user: 'admin', pass: 'admin123' } }, null, 2));
    } else {
        // Garante que a estrutura base existe se o ficheiro já foi criado
        const data = JSON.parse(fs.readFileSync(DB_FILE));
        if (!data.jogos) data.jogos = [];
        if (!data.apostas) data.apostas = [];
        if (!data.admin) data.admin = { user: 'admin', pass: 'admin123' };
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    }
}

// --- Rotas da API para o Site (Front-end) ---

// Rota para o cliente (site) obter os jogos ativos
app.get('/jogos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE));
        // Filtra para enviar apenas jogos com status 'ativo'
        const activeGames = data.jogos.filter(j => j.status === 'ativo');
        res.json(activeGames);
    } catch (error) {
        // Se o arquivo não existir ou der erro, retorna uma lista vazia
        res.json([]);
    }
});

// Rota para criar a preferência de pagamento
app.post('/create-payment', async (req, res) => {
    const { gameId, type, amount, choice, userName, userPix } = req.body;

    if (!gameId || !type || !amount || !choice || !userName || !userPix) {
        return res.status(400).json({ error: 'Dados da aposta incompletos.' });
    }

    const data = JSON.parse(fs.readFileSync(DB_FILE));
    const game = data.jogos.find(j => j.id === gameId);
    if (!game || game.status !== 'ativo') {
        return res.status(400).json({ error: 'Jogo não encontrado ou não está mais ativo.' });
    }
    
    const apostaId = `aposta-${Date.now()}`;

    const newBet = {
        id: apostaId,
        gameId,
        type,
        amount,
        choice,
        userName,
        userPix,
        status: 'pendente' // Status inicial
    };
    data.apostas.push(newBet);
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

    const preference = {
        items: [{
            title: `Aposta em ${game.time_a} vs ${game.time_b}`,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: amount
        }],
        back_urls: {
            success: `${req.protocol}://${req.get('host')}/payment-success`, // Crie estas páginas se quiser
            failure: `${req.protocol}://${req.get('host')}/payment-failure`,
        },
        auto_return: 'approved',
        external_reference: apostaId, // Usamos o ID da aposta como referência externa
    };

    try {
        const response = await mercadopago.preferences.create(preference);
        res.json({ init_point: response.body.init_point });
    } catch (error) {
        console.error("Erro ao criar preferência no Mercado Pago:", error);
        res.status(500).json({ error: 'Falha ao comunicar com o sistema de pagamento.' });
    }
});

// --- Rotas do Painel de Administração ---

// Rota para a página de login do admin
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Login</title>
            <style>
                body { font-family: sans-serif; background: #2c2c2c; color: #f0f0f0; display: flex; justify-content: center; align-items: center; height: 100vh; }
                .login-container { background: #333; padding: 40px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); text-align: center; }
                h1 { color: #4CAF50; }
                input { width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #555; background: #444; color: #f0f0f0; box-sizing: border-box; }
                button { background: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
                button:hover { background: #45a049; }
            </style>
        </head>
        <body>
            <div class="login-container">
                <h1>Login do Administrador</h1>
                <form action="/admin/login" method="POST">
                    <input type="text" name="username" placeholder="Usuário" required>
                    <input type="password" name="password" placeholder="Senha" required>
                    <button type="submit">Entrar</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

// Rota para processar o login (simplificada, sem sessão por enquanto)
app.post('/admin/login', bodyParser.urlencoded({ extended: false }), (req, res) => {
    const { username, password } = req.body;
    const data = JSON.parse(fs.readFileSync(DB_FILE));
    if (username === data.admin.user && password === data.admin.pass) {
        // Redireciona para o painel principal. 
        // Em uma aplicação real, aqui você criaria uma sessão.
        res.redirect('/admin/dashboard');
    } else {
        res.send('Usuário ou senha inválidos. <a href="/admin">Tentar novamente</a>');
    }
});


// Rota principal do dashboard do admin
app.get('/admin/dashboard', (req, res) => {
    const data = JSON.parse(fs.readFileSync(DB_FILE));
    
    const activeGamesList = data.jogos.filter(j => j.status === 'ativo').map(game => `
        <li>
            ${game.time_a} vs ${game.time_b} 
            <form action="/admin/game/finish" method="POST" style="display:inline;">
                <input type="hidden" name="gameId" value="${game.id}">
                <input type="text" name="placar" placeholder="Placar (ex: 2x1)" required>
                <button type="submit">Finalizar Jogo</button>
            </form>
        </li>
    `).join('');

    res.send(`
         <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <title>Admin Dashboard</title>
             <style>
                body { font-family: sans-serif; background: #2c2c2c; color: #f0f0f0; margin: 20px; }
                .container { max-width: 800px; margin: auto; background: #333; padding: 20px; border-radius: 10px; }
                h1, h2 { color: #4CAF50; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
                ul { list-style: none; padding: 0; }
                li { background: #444; padding: 15px; margin-bottom: 10px; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
                form { margin-top: 20px; }
                input[type="text"], input[type="url"] { width: 40%; padding: 8px; margin-right: 10px; border-radius: 4px; border: 1px solid #555; background: #555; color: #f0f0f0; }
                button { background: #4CAF50; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; }
                button:hover { background: #45a049; }
                .finish-form button { background: #e74c3c; }
                .finish-form button:hover { background: #c0392b; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Painel de Administração</h1>
                
                <h2>Criar Novo Jogo</h2>
                <form action="/admin/game/create" method="POST">
                    <input type="text" name="time_a" placeholder="Nome do Time A" required>
                    <input type="url" name="logo_a" placeholder="URL do Logo A" required>
                    <br><br>
                    <input type="text" name="time_b" placeholder="Nome do Time B" required>
                    <input type="url" name="logo_b" placeholder="URL do Logo B" required>
                    <br><br>
                    <button type="submit">Criar Jogo</button>
                </form>

                <h2>Jogos Ativos</h2>
                <ul>${activeGamesList || "<li>Nenhum jogo ativo.</li>"}</ul>
            </div>
        </body>
        </html>
    `);
});


// Rota para criar um novo jogo
app.post('/admin/game/create', bodyParser.urlencoded({ extended: false }), (req, res) => {
    const { time_a, logo_a, time_b, logo_b } = req.body;
    const data = JSON.parse(fs.readFileSync(DB_FILE));
    
    const newGame = {
        id: `game-${Date.now()}`,
        time_a,
        logo_a,
        time_b,
        logo_b,
        status: 'ativo', // 'ativo', 'finalizado'
        resultado: null
    };

    data.jogos.push(newGame);
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    res.redirect('/admin/dashboard');
});

// Rota para finalizar um jogo
app.post('/admin/game/finish', bodyParser.urlencoded({ extended: false }), (req, res) => {
    const { gameId, placar } = req.body;
    const data = JSON.parse(fs.readFileSync(DB_FILE));

    const game = data.jogos.find(j => j.id === gameId);
    if (game) {
        game.status = 'finalizado';
        game.resultado = placar; // Armazenamos o placar final
        
        // Lógica para definir vencedores (exemplo simples)
        // Você precisará expandir isso para os diferentes tipos de aposta
        const [scoreA, scoreB] = placar.split('x').map(Number);
        const vencedor = scoreA > scoreB ? game.time_a : (scoreB > scoreA ? game.time_b : 'Empate');

        const apostasDoJogo = data.apostas.filter(a => a.gameId === gameId && a.status === 'pago'); // Supondo que o status seja 'pago'
        apostasDoJogo.forEach(aposta => {
            if (aposta.type === 'vencedor' && aposta.choice === vencedor) {
                aposta.resultado = 'ganhou';
            } else if (aposta.type === 'placar' && aposta.choice === placar) {
                 aposta.resultado = 'ganhou';
            } else {
                 aposta.resultado = 'perdeu';
            }
        });

    }
    
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    res.redirect('/admin/dashboard');
});


// --- Inicialização do Servidor ---
app.listen(PORT, () => {
    initializeDatabase();
    console.log(`Servidor do AgroBet está no ar na porta ${PORT}`);
    console.log(`Painel de Admin: http://localhost:${PORT}/admin`);
});
