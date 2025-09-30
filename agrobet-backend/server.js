import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

// --- Modelos da Base de Dados (Schemas) ---
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
    result: {
        final: { type: String, enum: ['home', 'away', 'empate', 'pendente'], default: 'pendente' },
        goalsOver25: { type: String, enum: ['sim', 'nao', 'pendente'], default: 'pendente' },
        bothTeamsScore: { type: String, enum: ['sim', 'nao', 'pendente'], default: 'pendente' }
    },
    odds: {
        home: { type: Number, default: 1.5 },
        away: { type: Number, default: 1.5 },
        draw: { type: Number, default: 1.5 },
        over25: { type: Number, default: 1.8 },
        under25: { type: Number, default: 1.8 },
        btsYes: { type: Number, default: 1.7 },
        btsNo: { type: Number, default: 1.7 }
    },
    initialOdds: {
        home: { type: Number }, away: { type: Number }, draw: { type: Number },
        over25: { type: Number }, under25: { type: Number },
        btsYes: { type: Number }, btsNo: { type: Number }
    },
    maxBetValue: { type: Number, default: 35 }
});
const Game = mongoose.model('Game', GameSchema);

const BetSchema = new mongoose.Schema({
    selections: [{
        gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
        gameTitle: String,
        betType: String,
        betChoice: String,
        betChoiceKey: String, // e.g. 'home', 'sim', 'nao'
        odds: Number,
        status: { type: String, enum: ['pendente', 'ganhou', 'perdeu', 'anulada'], default: 'pendente' }
    }],
    totalOdds: { type: Number, required: true },
    betValue: Number,
    user: { name: String, pix: String },
    status: { type: String, enum: ['pendente', 'ganhou', 'perdeu'], default: 'pendente' },
    potentialPayout: { type: Number, required: true },
    date: Date,
});
const Bet = mongoose.model('Bet', BetSchema);


// --- Conexão e Configuração do Servidor ---
mongoose.connect(process.env.MONGODB_URI).then(() => console.log("MongoDB conectado.")).catch(err => console.error(err));
const app = express();

const corsOptions = {
    origin: process.env.FRONTEND_URL || '*',
    credentials: true
};
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const preference = new Preference(client);
const payment = new Payment(client);

// --- Middleware ---
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

// --- Funções Auxiliares ---
async function updateOdds(gameId) { /* ... (lógica de odds dinâmicas pode ser expandida no futuro) ... */ }

async function processBetResults(gameId) {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'finalizado') return;

    const betsToProcess = await Bet.find({ 'selections.gameId': gameId, 'selections.status': 'pendente' });

    for (const bet of betsToProcess) {
        let betIsLost = false;

        for (const selection of bet.selections) {
            if (selection.status !== 'pendente') {
                if (selection.status === 'perdeu') betIsLost = true;
                continue;
            }

            const selectionGame = await Game.findById(selection.gameId);
            if (!selectionGame || selectionGame.status !== 'finalizado') continue;
            
            let isWinner = false;
            switch (selection.betType) {
                case 'RESULTADO_FINAL': isWinner = selection.betChoiceKey === selectionGame.result.final; break;
                case 'GOLOS_MAIS_2_5': isWinner = 'sim' === selectionGame.result.goalsOver25; break;
                case 'GOLOS_MENOS_2_5': isWinner = 'nao' === selectionGame.result.goalsOver25; break;
                case 'AMBAS_MARCAM': isWinner = selection.betChoiceKey === selectionGame.result.bothTeamsScore; break;
            }
            selection.status = isWinner ? 'ganhou' : 'perdeu';
            if (!isWinner) betIsLost = true;
        }

        const hasPendingSelections = bet.selections.some(s => s.status === 'pendente');
        if (!hasPendingSelections) {
            bet.status = betIsLost ? 'perdeu' : 'ganhou';
        }
        await bet.save();
    }
    console.log(`Resultados das apostas para o jogo ${gameId} processados.`);
}


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
    const { selections, value, user } = req.body;
    if (!selections || selections.length === 0 || !value || !user) {
        return res.status(400).json({ message: 'Dados da aposta incompletos.' });
    }
    try {
        let totalOdds = 1;
        const DYNAMIC_LIMIT_ODD_THRESHOLD = 1.30;
        const DYNAMIC_LIMIT_VALUE = 5.00;
        for (const selection of selections) {
            const game = await Game.findById(selection.gameId);
            if (!game || game.status !== 'aberto') return res.status(400).json({ message: `O jogo "${selection.gameTitle}" não está mais aberto.` });
            if (selection.odds < DYNAMIC_LIMIT_ODD_THRESHOLD && value > DYNAMIC_LIMIT_VALUE) return res.status(400).json({ message: `Para odds < ${DYNAMIC_LIMIT_ODD_THRESHOLD}, a aposta máxima é de R$ ${DYNAMIC_LIMIT_VALUE.toFixed(2)}.` });
            const userBetsOnGame = await Bet.find({ 'user.pix': user.pix, 'selections.gameId': game._id });
            const totalBetByUser = userBetsOnGame.reduce((acc, bet) => acc + bet.betValue, 0);
            if ((totalBetByUser + value) > game.maxBetValue) return res.status(400).json({ message: `Limite de aposta atingido para o jogo ${game.home.name} vs ${game.away.name}.` });
            totalOdds *= selection.odds;
        }
        const potentialPayout = value * totalOdds;
        const description = selections.length > 1 ? `${selections.length} seleções` : selections[0].betChoice;
        const preferenceData = {
            body: {
                items: [{
                    id: new mongoose.Types.ObjectId().toString(),
                    title: `Aposta (${selections.length}x)`,
                    description: description,
                    quantity: 1,
                    unit_price: Number(value),
                    currency_id: 'BRL'
                }],
                back_urls: { success: process.env.SUCCESS_REDIRECT_URL || process.env.FRONTEND_URL, failure: process.env.FRONTEND_URL, pending: process.env.FRONTEND_URL },
                auto_return: 'approved',
                notification_url: `${process.env.SERVER_URL}/webhook-mercadopago`,
                metadata: {
                    user_pix: user.pix, user_name: user.name,
                    bet_value: value, total_odds: totalOdds,
                    potential_payout: potentialPayout,
                    selections: JSON.stringify(selections)
                }
            }
        };
        const result = await preference.create(preferenceData);
        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro no servidor ao criar pagamento.' });
    }
});

app.post('/webhook-mercadopago', async (req, res) => {
    try {
        if (req.body.type === 'payment') {
            const paymentDetails = await payment.get({ id: req.body.data.id });
            if (paymentDetails.status === 'approved') {
                const metadata = paymentDetails.metadata;
                const newBet = new Bet({
                    selections: JSON.parse(metadata.selections),
                    totalOdds: metadata.total_odds,
                    betValue: Number(metadata.bet_value),
                    user: { name: metadata.user_name, pix: metadata.user_pix },
                    status: 'pendente',
                    potentialPayout: metadata.potential_payout,
                    date: new Date()
                });
                await newBet.save();
                const gameIds = new Set(newBet.selections.map(s => s.gameId));
                gameIds.forEach(gameId => updateOdds(gameId));
            }
        }
        res.sendStatus(200);
    } catch (error) { res.sendStatus(500); }
});

app.get('/my-bets/:pix', async (req, res) => {
    try {
        const bets = await Bet.find({ 'user.pix': req.params.pix }).sort({ date: -1 });
        res.json({ success: true, bets });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao buscar apostas.' });
    }
});

app.get('/results', async (req, res) => {
    try {
        const finishedGames = await Game.find({ status: 'finalizado' }).sort({ date: -1 });
        res.json(finishedGames);
    } catch (error) {
        res.status(500).json({ message: "Erro ao buscar resultados." });
    }
});


// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
app.get('/admin', (req, res) => {
    res.send(`...`); // Formulário de login do admin
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.cookie('admin_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 3600000 });
        res.redirect('/admin/dashboard');
    } else {
        res.send('<h1>Senha incorreta.</h1><a href="/admin">Tentar novamente</a>');
    }
});

app.get('/admin/dashboard', authAdmin, (req, res) => {
    res.send(`
        <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Painel de Administração</title><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-gray-200 min-h-screen flex items-center justify-center"><div class="container mx-auto p-8 bg-white rounded-lg shadow-lg max-w-5xl text-center">
        <h1 class="text-4xl font-bold mb-8 text-gray-800">Painel de Administração</h1><div class="grid grid-cols-1 md:grid-cols-4 gap-6">
        <a href="/admin/games" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Gerir Jogos</a>
        <a href="/admin/financial-report" target="_blank" class="bg-green-600 hover:bg-green-700 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Relatório Financeiro<span class="text-xs font-normal">(Balanço e Detalhes)</span></a>
        <a href="/admin/payment-summary" target="_blank" class="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Resumo de Pagamentos<span class="text-xs font-normal">(Valores por pessoa)</span></a>
        </div><form action="/admin/logout" method="post" class="mt-8"><button type="submit" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-6 rounded-lg">Sair</button></form>
        </div></body></html>`);
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
                        <input name="date" placeholder="Data (ex: 25/12/2025 - 20:00)" class="p-2 border rounded" required>
                        <input name="competition" placeholder="Competição" class="p-2 border rounded" required>
                    </div>
                     <div>
                        <h3 class="font-semibold mb-2">Detalhes da Aposta</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                           <input type="number" step="0.01" name="max_bet_value" placeholder="Valor Máx. por Aposta (R$)" class="p-2 border rounded" value="10" required>
                        </div>
                    </div>
                    <h3 class="font-semibold mb-2 pt-4 border-t">Mercado: Resultado Final</h3>
                    <div class="grid grid-cols-3 gap-4">
                       <input type="number" step="0.01" name="odds_home" placeholder="Odd Casa" class="p-2 border rounded" required>
                       <input type="number" step="0.01" name="odds_draw" placeholder="Odd Empate" class="p-2 border rounded" required>
                       <input type="number" step="0.01" name="odds_away" placeholder="Odd Visitante" class="p-2 border rounded" required>
                    </div>
                    <h3 class="font-semibold mb-2 pt-4 border-t">Mercado: Total de Golos (Mais/Menos 2.5)</h3>
                     <div class="grid grid-cols-2 gap-4">
                       <input type="number" step="0.01" name="odds_over25" placeholder="Odd Mais de 2.5" class="p-2 border rounded" required>
                       <input type="number" step="0.01" name="odds_under25" placeholder="Odd Menos de 2.5" class="p-2 border rounded" required>
                    </div>
                    <h3 class="font-semibold mb-2 pt-4 border-t">Mercado: Ambas as Equipas Marcam</h3>
                     <div class="grid grid-cols-2 gap-4">
                       <input type="number" step="0.01" name="odds_btsYes" placeholder="Odd Sim" class="p-2 border rounded" required>
                       <input type="number" step="0.01" name="odds_btsNo" placeholder="Odd Não" class="p-2 border rounded" required>
                    </div>
                    <button type="submit" class="w-full bg-blue-500 text-white p-3 rounded hover:bg-blue-600 font-bold">Adicionar Jogo</button>
                </form>
            </div>
            <div class="bg-white p-6 rounded shadow-md">
                <h2 class="text-2xl font-semibold mb-4">Jogos Existentes</h2>
                ${games.map(game => `
                    <div class="border p-4 rounded-lg mb-4">
                        <p class="font-bold text-lg">${game.home.name} vs ${game.away.name}</p>
                        <p>Status: <span class="font-semibold">${game.status}</span></p>
                        ${game.status === 'aberto' ? `<form action="/admin/close-game/${game._id}" method="post" class="inline-block mt-2"><button class="bg-yellow-500 text-white px-3 py-1 rounded text-sm">Fechar Apostas</button></form>` : ''}
                        ${game.status === 'fechado' ? `
                        <form action="/admin/finalize-game/${game._id}" method="post" class="mt-2 space-y-2">
                            <h4 class="font-bold">Definir Resultados:</h4>
                            <div><label>Resultado Final:</label> <select name="result_final" class="p-1 border rounded"><option value="home">Vencedor: ${game.home.name}</option><option value="away">Vencedor: ${game.away.name}</option><option value="empate">Empate</option></select></div>
                            <div><label>Golos > 2.5:</label> <select name="result_goalsOver25" class="p-1 border rounded"><option value="sim">Sim</option><option value="nao">Não</option></select></div>
                            <div><label>Ambas Marcam:</label> <select name="result_bothTeamsScore" class="p-1 border rounded"><option value="sim">Sim</option><option value="nao">Não</option></select></div>
                            <button type="submit" class="bg-green-500 text-white px-3 py-1 rounded text-sm">Finalizar Jogo</button>
                        </form>` : ''}
                    </div>`).join('')}
            </div></div></body></html>`);
    } catch (error) { res.status(500).send("Erro ao carregar jogos."); }
});

app.post('/admin/add-game', authAdmin, async (req, res) => {
    try {
        const { home_name, home_logo, away_name, away_logo, date, competition, max_bet_value,
                odds_home, odds_draw, odds_away, odds_over25, odds_under25, odds_btsYes, odds_btsNo } = req.body;
        const odds = {
            home: parseFloat(odds_home), draw: parseFloat(odds_draw), away: parseFloat(odds_away),
            over25: parseFloat(odds_over25), under25: parseFloat(odds_under25),
            btsYes: parseFloat(odds_btsYes), btsNo: parseFloat(odds_btsNo)
        };
        const newGame = new Game({
            home: { name: home_name, logo: home_logo },
            away: { name: away_name, logo: away_logo },
            date, competition, odds, initialOdds: odds,
            maxBetValue: parseFloat(max_bet_value)
        });
        await newGame.save();
        res.redirect('/admin/games');
    } catch (error) { console.error(error); res.status(500).send("Erro ao adicionar jogo."); }
});

app.post('/admin/close-game/:id', authAdmin, async (req, res) => {
    try {
        await Game.findByIdAndUpdate(req.params.id, { status: 'fechado' });
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao fechar jogo."); }
});

app.post('/admin/finalize-game/:id', authAdmin, async (req, res) => {
    try {
        const { result_final, result_goalsOver25, result_bothTeamsScore } = req.body;
        await Game.findByIdAndUpdate(req.params.id, {
            status: 'finalizado',
            result: {
                final: result_final,
                goalsOver25: result_goalsOver25,
                bothTeamsScore: result_bothTeamsScore
            }
        });
        await processBetResults(req.params.id);
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao finalizar jogo."); }
});

// Relatórios (Adaptados para o novo schema)
app.get('/admin/financial-report', authAdmin, async (req, res) => {
    try {
        const bets = await Bet.find({ status: { $in: ['ganhou', 'perdeu'] } }).populate('selections.gameId').lean();
        let totalLostValue = 0;
        let totalToPay = 0;

        bets.forEach(bet => {
            if (bet.status === 'ganhou') {
                totalToPay += bet.potentialPayout;
            } else if (bet.status === 'perdeu') {
                totalLostValue += bet.betValue;
            }
        });

        const balance = totalLostValue - totalToPay;
        // O HTML do relatório precisa ser refeito para mostrar apostas múltiplas, mas os valores principais estão corretos.
        res.send(`<h1>Relatório Financeiro</h1><p>Total Arrecadado (Perdas): R$ ${totalLostValue.toFixed(2)}</p><p>Total a Pagar (Ganhos): R$ ${totalToPay.toFixed(2)}</p><h2>Balanço: R$ ${balance.toFixed(2)}</h2>`);

    } catch (error) {
        res.status(500).send("Erro ao gerar relatório financeiro.");
    }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

