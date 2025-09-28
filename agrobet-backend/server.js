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
    },
    initialOdds: {
        home: { type: Number },
        away: { type: Number },
        draw: { type: Number }
    },
    maxBetValue: { type: Number, default: 35 }
});
const Game = mongoose.model('Game', GameSchema);

const BetSchema = new mongoose.Schema({
    paymentId: { type: String, unique: true, sparse: true },
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
    gameTitle: String,
    betChoice: String,
    betValue: Number,
    date: Date,
    user: { name: String, pix: String },
    status: { type: String, enum: ['approved', 'pending', 'refunded'], default: 'pending' },
    odds: { type: Number, required: true },
    potentialPayout: { type: Number, required: true }
}));
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

// --- Função Auxiliar para Formatar Data ---
const formatBetDate = (dateString) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
};

// --- Função para Odds Dinâmicas ---
async function updateOdds(gameId) {
    try {
        const VIG = 0.10;
        const PAYOUT_RATE = 1 - VIG;
        const MIN_ODD = 1.01;
        const MAX_ODD = 3.50;
        const STARTING_POOL = 60;
        const MATURITY_POOL = 400;

        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto' || !game.initialOdds) return;

        const bets = await Bet.find({ gameId: gameId, status: 'approved' });

        let totalBetHome = 0;
        let totalBetAway = 0;
        let totalBetDraw = 0;

        bets.forEach(bet => {
            if (bet.betChoice === game.home.name) totalBetHome += bet.betValue;
            else if (bet.betChoice === game.away.name) totalBetAway += bet.betValue;
            else if (bet.betChoice === 'Empate') totalBetDraw += bet.betValue;
        });

        const totalPool = totalBetHome + totalBetAway + totalBetDraw;
        
        if (totalPool < STARTING_POOL) return; 

        const poolBasedOddHome = (totalPool * PAYOUT_RATE) / (totalBetHome || 1);
        const poolBasedOddAway = (totalPool * PAYOUT_RATE) / (totalBetAway || 1);
        const poolBasedOddDraw = (totalPool * PAYOUT_RATE) / (totalBetDraw || 1);

        const initialOddsWeight = Math.max(0, 1 - (totalPool / MATURITY_POOL));

        const calculatedOddHome = (poolBasedOddHome * (1 - initialOddsWeight)) + (game.initialOdds.home * initialOddsWeight);
        const calculatedOddAway = (poolBasedOddAway * (1 - initialOddsWeight)) + (game.initialOdds.away * initialOddsWeight);
        const calculatedOddDraw = (poolBasedOddDraw * (1 - initialOddsWeight)) + (game.initialOdds.draw * initialOddsWeight);
        
        const newOddHome = Math.min(MAX_ODD, Math.max(MIN_ODD, calculatedOddHome));
        const newOddAway = Math.min(MAX_ODD, Math.max(MIN_ODD, calculatedOddAway));
        const newOddDraw = Math.min(MAX_ODD, Math.max(MIN_ODD, calculatedOddDraw));


        await Game.findByIdAndUpdate(gameId, {
            $set: {
                'odds.home': newOddHome,
                'odds.away': newOddAway,
                'odds.draw': newOddDraw,
            }
        });

    } catch (error) {
        console.error(`Erro ao atualizar odds para o jogo ${gameId}:`, error);
    }
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
    const { gameId, option, value, user } = req.body;
    try {
        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto') {
            return res.status(400).json({ message: 'Este jogo não está mais aberto para apostas.' });
        }
        
        const userBetsOnGame = await Bet.find({ gameId: gameId, 'user.pix': user.pix, status: 'approved' });
        const totalBetByUser = userBetsOnGame.reduce((acc, bet) => acc + bet.betValue, 0);

        if ((totalBetByUser + value) > game.maxBetValue) {
            const remainingValue = game.maxBetValue - totalBetByUser;
            if (remainingValue <= 0) {
                return res.status(400).json({ message: `Já atingiu o seu limite de aposta de R$ ${game.maxBetValue.toFixed(2)} para este jogo.` });
            }
            return res.status(400).json({ message: `O seu limite total para este jogo é R$ ${game.maxBetValue.toFixed(2)}. Ainda pode apostar até R$ ${remainingValue.toFixed(2)}.` });
        }


        const oddsKey = option === 'empate' ? 'draw' : option;
        const odds = game.odds[oddsKey];
        const potentialPayout = value * odds;
        const betChoiceText = option === 'empate' ? 'Empate' : game[option].name;
        
        const redirectUrl = process.env.SUCCESS_REDIRECT_URL || process.env.FRONTEND_URL;

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
                back_urls: { success: redirectUrl, failure: redirectUrl, pending: redirectUrl },
                auto_return: 'approved', 
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
        console.error(error);
        res.status(500).json({ message: 'Erro no servidor ao criar pagamento.' });
    }
});

app.post('/webhook-mercadopago', async (req, res) => {
    try {
        if (req.body.type === 'payment') {
            const paymentDetails = await payment.get({ id: req.body.data.id });
            const paymentId = paymentDetails.id.toString();

            if (paymentDetails.status === 'approved') {
                const existingBet = await Bet.findOne({ paymentId: paymentId });
                if (existingBet) {
                    return res.sendStatus(200);
                }

                const metadata = paymentDetails.metadata;
                const game = await Game.findById(metadata.game_id);
                const newBet = new Bet({
                    paymentId: paymentId,
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
                updateOdds(metadata.game_id);

            } else if (paymentDetails.status === 'refunded' || paymentDetails.status === 'cancelled') {
                const betToUpdate = await Bet.findOne({ paymentId: paymentId });
                if (betToUpdate && betToUpdate.status !== 'refunded') {
                    betToUpdate.status = 'refunded';
                    await betToUpdate.save();
                    updateOdds(betToUpdate.gameId);
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("Erro no webhook do Mercado Pago:", error);
        res.sendStatus(500);
    }
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
        const bets = await Bet.find().sort({ date: -1 });
        let html = `
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório de Apostas</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto bg-white p-6 rounded-lg shadow-md">
            <h1 class="text-3xl font-bold mb-6 text-gray-800">Relatório de Apostas Confirmadas</h1><div class="overflow-x-auto">
            <table class="min-w-full bg-white"><thead class="bg-gray-800 text-white">
            <tr><th class="py-3 px-4 text-left">Data</th><th class="py-3 px-4 text-left">Utilizador</th><th class="py-3 px-4 text-left">Jogo</th><th class="py-3 px-4 text-left">Palpite</th><th class="py-3 px-4 text-left">Valor</th><th class="py-3 px-4 text-left">Status</th><th class="py-3 px-4 text-left">Retorno Pot.</th></tr>
            </thead><tbody>`;
        bets.forEach(bet => {
            html += `<tr class="border-b"><td class="py-3 px-4">${formatBetDate(bet.date)}</td><td class="py-3 px-4">${bet.user.name}</td><td class="py-3 px-4">${bet.gameTitle}</td><td class="py-3 px-4">${bet.betChoice}</td><td class="py-3 px-4">R$ ${bet.betValue.toFixed(2)}</td><td class="py-3 px-4 font-semibold ${bet.status === 'refunded' ? 'text-red-500' : 'text-green-500'}">${bet.status}</td><td class="py-3 px-4 font-semibold text-gray-700">R$ ${bet.potentialPayout.toFixed(2)}</td></tr>`;
        });
        html += `</tbody></table></div></div></body></html>`;
        res.send(html);
    } catch (error) { res.status(500).send("Erro ao gerar o relatório."); }
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
        <body class="bg-gray-200 min-h-screen flex items-center justify-center"><div class="container mx-auto p-8 bg-white rounded-lg shadow-lg max-w-7xl text-center">
        <h1 class="text-4xl font-bold mb-8 text-gray-800">Painel de Administração</h1><div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        <a href="/admin/games" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Gerir Jogos</a>
        <a href="/admin/users" class="bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Gerir Utilizadores</a>
        <a href="/relatorio" target="_blank" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Relatório Geral<span class="text-xs font-normal">(Todas as apostas)</span></a>
        <a href="/admin/financial-report" target="_blank" class="bg-green-600 hover:bg-green-700 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Relatório Financeiro<span class="text-xs font-normal">(Balanço e Detalhes)</span></a>
        <a href="/admin/payment-summary" target="_blank" class="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Resumo de Pagamentos<span class="text-xs font-normal">(Valores por pessoa)</span></a>
        <a href="/admin/maintenance" class="bg-red-700 hover:bg-red-800 text-white font-bold py-6 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 flex flex-col justify-center">Manutenção<span class="text-xs font-normal">(Limpar Histórico)</span></a>
        </div><form action="/admin/logout" method="post" class="mt-8"><button type="submit" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-6 rounded-lg">Sair</button></form>
        </div></body></html>`);
});

app.get('/admin/financial-report', authAdmin, async (req, res) => {
    try {
        const bets = await Bet.find({ status: { $in: ['approved', 'refunded'] } }).populate('gameId').lean();
        const finalizedGames = await Game.find({ status: 'finalizado' }).lean();

        const reportData = [];
        let totalLostValue = 0;
        let totalToPay = 0;

        for (const game of finalizedGames) {
            const betsForGame = bets.filter(bet => bet.gameId && bet.gameId._id.equals(game._id));

            for (const bet of betsForGame) {
                let isWinner = false;
                const gameResult = game.result; 
                const betChoice = bet.betChoice; 

                if (gameResult === 'empate' && betChoice === 'Empate') isWinner = true;
                else if (gameResult === 'home' && betChoice === game.home.name) isWinner = true;
                else if (gameResult === 'away' && betChoice === game.away.name) isWinner = true;
                
                let resultText = 'Pendente';
                 if (game.result === 'home') resultText = `Vencedor: ${game.home.name}`;
                 else if (game.result === 'away') resultText = `Vencedor: ${game.away.name}`;
                 else if (game.result === 'empate') resultText = 'Empate';

                const betStatus = bet.status === 'refunded' ? 'Reembolsada' : (isWinner ? 'Ganhou' : 'Perdeu');

                reportData.push({
                    ...bet,
                    gameResult: resultText,
                    betStatus: betStatus,
                    amountToPay: bet.status !== 'refunded' && isWinner ? bet.potentialPayout : 0,
                });

                if (bet.status !== 'refunded') {
                    if (isWinner) {
                        totalToPay += bet.potentialPayout;
                    } else {
                        totalLostValue += bet.betValue;
                    }
                }
            }
        }
        
        const balance = totalLostValue - totalToPay;

        let reportTableRows = '';
        if (reportData.length > 0) {
            reportTableRows = reportData.map(bet => `
                <tr class="border-b ${bet.betStatus === 'Reembolsada' ? 'bg-red-50' : ''}" data-game-title="${bet.gameTitle}">
                    <td class="py-3 px-4">${formatBetDate(bet.date)}</td>
                    <td class="py-3 px-4">${bet.user.name}</td>
                    <td class="py-3 px-4">${bet.user.pix}</td>
                    <td class="py-3 px-4">${bet.gameTitle}</td>
                    <td class="py-3 px-4">${bet.betChoice}</td>
                    <td class="py-3 px-4">${bet.gameResult}</td>
                    <td class="py-3 px-4">R$ ${bet.betValue.toFixed(2)}</td>
                    <td class="py-3 px-4 font-semibold ${bet.betStatus === 'Ganhou' ? 'text-green-600' : 'text-red-600'}">${bet.betStatus}</td>
                    <td class="py-3 px-4 font-bold text-blue-700">R$ ${bet.amountToPay.toFixed(2)}</td>
                </tr>
            `).join('');
        } else {
            reportTableRows = `
                <tr>
                    <td colspan="9" class="text-center py-10 text-gray-500">
                        <p class="font-bold text-lg">Nenhum dado para exibir no relatório.</p>
                        <p>Isto pode acontecer porque ainda não há jogos finalizados que tenham apostas confirmadas.</p>
                    </td>
                </tr>
            `;
        }

        res.send(`
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório Financeiro</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-4 md:p-8">
                <div class="container mx-auto bg-white p-6 rounded-lg shadow-md">
                    <div class="flex flex-wrap justify-between items-center mb-6">
                        <h1 class="text-3xl font-bold text-gray-800">Relatório Financeiro Detalhado</h1>
                        <div>
                            <a href="/admin/payment-summary" class="bg-yellow-500 text-white font-bold py-2 px-4 rounded-md hover:bg-yellow-600 mr-2">Ver Resumo de Pagamentos</a>
                            <button id="export-csv" class="bg-green-600 text-white font-bold py-2 px-4 rounded-md hover:bg-green-700">Exportar para Excel (CSV)</button>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8 text-center">
                        <div class="bg-red-100 p-4 rounded-lg"><p class="text-sm text-red-700">Arrecadado (Perdas)</p><p class="text-2xl font-bold text-red-800">R$ ${totalLostValue.toFixed(2)}</p></div>
                        <div class="bg-blue-100 p-4 rounded-lg"><p class="text-sm text-blue-700">A Pagar (Ganhos)</p><p class="text-2xl font-bold text-blue-800">R$ ${totalToPay.toFixed(2)}</p></div>
                        <div class="bg-green-100 p-4 rounded-lg"><p class="text-sm text-green-700">Balanço (Lucro)</p><p class="text-2xl font-bold text-green-800">R$ ${balance.toFixed(2)}</p></div>
                    </div>
                    <div class="flex items-center mb-4">
                        <label for="gameFilter" class="mr-2 font-semibold">Filtrar por Jogo:</label>
                        <select id="gameFilter" class="p-2 border rounded-md">
                            <option value="all">Todos os Jogos</option>
                            ${finalizedGames.map(g => `<option value="${g.home.name} vs ${g.away.name}">${g.home.name} vs ${g.away.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="overflow-x-auto">
                        <table id="report-table" class="min-w-full bg-white">
                            <thead class="bg-gray-800 text-white">
                                <tr>
                                    <th class="py-3 px-4 text-left">Data</th>
                                    <th class="py-3 px-4 text-left">Utilizador</th>
                                    <th class="py-3 px-4 text-left">Chave PIX</th>
                                    <th class="py-3 px-4 text-left">Jogo</th>
                                    <th class="py-3 px-4 text-left">Palpite</th>
                                    <th class="py-3 px-4 text-left">Resultado do Jogo</th>
                                    <th class="py-3 px-4 text-left">Valor Aposta</th>
                                    <th class="py-3 px-4 text-left">Status</th>
                                    <th class="py-3 px-4 text-left">Prémio</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${reportTableRows}
                            </tbody>
                        </table>
                    </div>
                </div>
                <script>
                    document.getElementById('gameFilter').addEventListener('change', function() {
                        const selectedGame = this.value;
                        const tableRows = document.querySelectorAll('#report-table tbody tr');
                        tableRows.forEach(row => {
                            if (selectedGame === 'all' || row.dataset.gameTitle === selectedGame) {
                                row.style.display = '';
                            } else {
                                row.style.display = 'none';
                            }
                        });
                    });
                    function downloadCSV(csv, filename) {
                        const csvFile = new Blob(["\\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
                        const link = document.createElement("a");
                        link.href = URL.createObjectURL(csvFile);
                        link.download = filename;
                        link.style.display = "none";
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                    }
                    document.getElementById('export-csv').addEventListener('click', function() {
                        const table = document.getElementById('report-table');
                        const rows = table.querySelectorAll('tr');
                        let csv = [];
                        for (let i = 0; i < rows.length; i++) {
                            const row = [], cols = rows[i].querySelectorAll('td, th');
                            if (rows[i].style.display !== 'none') {
                                for (let j = 0; j < cols.length; j++) {
                                    row.push('"' + cols[j].innerText.replace(/\\n/g, ' ') + '"');
                                }
                                csv.push(row.join(','));
                            }
                        }
                        const now = new Date();
                        const timestamp = \`\${now.getFullYear()}-\${String(now.getMonth() + 1).padStart(2, '0')}-\${String(now.getDate()).padStart(2, '0')}_\${String(now.getHours()).padStart(2, '0')}-\${String(now.getMinutes()).padStart(2, '0')}\`;
                        const filename = \`relatorio_financeiro_\${timestamp}.csv\`;
                        downloadCSV(csv.join('\\n'), filename);
                    });
                </script>
            </body></html>
        `);
    } catch (error) {
        console.error("Erro ao gerar relatório financeiro:", error);
        res.status(500).send("Erro ao gerar o relatório financeiro.");
    }
});

app.get('/admin/payment-summary', authAdmin, async (req, res) => {
    try {
        const bets = await Bet.find({ status: 'approved' }).populate('gameId').lean();
        const finalizedGames = await Game.find({ status: 'finalizado' }).lean();

        const paymentsByUser = {};

        const finalizedGameIds = finalizedGames.map(g => g._id.toString());
        const relevantBets = bets.filter(b => b.gameId && finalizedGameIds.includes(b.gameId._id.toString()));

        for (const bet of relevantBets) {
            let isWinner = false;
            const game = bet.gameId;
            const gameResult = game.result; 
            const betChoice = bet.betChoice; 

            if (gameResult === 'empate' && betChoice === 'Empate') isWinner = true;
            else if (gameResult === 'home' && betChoice === game.home.name) isWinner = true;
            else if (gameResult === 'away' && betChoice === game.away.name) isWinner = true;

            if (isWinner) {
                const userPix = bet.user.pix;
                if (!paymentsByUser[userPix]) {
                    paymentsByUser[userPix] = { name: bet.user.name, totalToPay: 0 };
                }
                paymentsByUser[userPix].totalToPay += bet.potentialPayout;
            }
        }

        let paymentRows = '';
        if (Object.keys(paymentsByUser).length > 0) {
            paymentRows = Object.entries(paymentsByUser).map(([pix, data]) => `
                <tr class="border-b">
                    <td class="py-3 px-4">${data.name}</td>
                    <td class="py-3 px-4">${pix}</td>
                    <td class="py-3 px-4 font-bold text-blue-700">R$ ${data.totalToPay.toFixed(2)}</td>
                </tr>
            `).join('');
        } else {
            paymentRows = `<tr><td colspan="3" class="text-center py-10 text-gray-500">Nenhum pagamento a ser feito.</td></tr>`;
        }

        res.send(`
             <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Resumo de Pagamentos</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-4 md:p-8">
                <div class="container mx-auto bg-white p-6 rounded-lg shadow-md max-w-4xl">
                    <div class="flex justify-between items-center mb-6">
                        <h1 class="text-3xl font-bold text-gray-800">Resumo de Pagamentos</h1>
                        <a href="/admin/financial-report" class="bg-blue-500 text-white font-bold py-2 px-4 rounded-md hover:bg-blue-600">Voltar ao Relatório Detalhado</a>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="min-w-full bg-white">
                            <thead class="bg-gray-800 text-white">
                                <tr>
                                    <th class="py-3 px-4 text-left">Utilizador</th>
                                    <th class="py-3 px-4 text-left">Chave PIX</th>
                                    <th class="py-3 px-4 text-left">Valor Total a Pagar</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${paymentRows}
                            </tbody>
                        </table>
                    </div>
                </div>
            </body></html>
        `);

    } catch (error) {
        console.error("Erro ao gerar resumo de pagamentos:", error);
        res.status(500).send("Erro ao gerar o resumo de pagamentos.");
    }
});

app.get('/admin/maintenance', authAdmin, (req, res) => {
    res.send(`
        <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Manutenção</title><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-gray-100 p-4 md:p-8">
            <div class="container mx-auto bg-white p-6 rounded-lg shadow-md max-w-4xl">
                <div class="flex justify-between items-center mb-6">
                    <h1 class="text-3xl font-bold text-gray-800">Manutenção do Site</h1>
                    <a href="/admin/dashboard" class="bg-blue-500 text-white font-bold py-2 px-4 rounded-md hover:bg-blue-600">Voltar ao Dashboard</a>
                </div>
                
                <div class="bg-red-100 border-l-4 border-red-500 text-red-800 p-4 rounded-md" role="alert">
                    <p class="font-bold text-lg">Atenção: Ações Irreversíveis</p>
                    <p>As ferramentas abaixo realizam exclusões permanentes na base de dados. Use com extrema cautela.</p>
                </div>
                
                <div class="mt-8 border-t pt-6">
                    <h2 class="text-2xl font-bold text-gray-700 mb-2">Limpar Histórico da Rodada</h2>
                    <p class="mb-4 text-gray-600">Esta ação foi desenhada para reiniciar o site para uma nova rodada de apostas. Ela irá apagar <strong>TODAS as apostas</strong> (ganhas, perdidas, pagas, reembolsadas, etc.) e <strong>TODOS os jogos com status "finalizado"</strong>. Os jogos abertos e os utilizadores não serão afetados.</p>
                    <form action="/admin/clear-history" method="POST" onsubmit="return confirm('Tem a certeza ABSOLUTA que deseja apagar todo o histórico de apostas e jogos finalizados? Esta ação não pode ser desfeita.');">
                        <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-4 rounded-lg text-lg">Apagar Histórico Agora</button>
                    </form>
                </div>
            </div>
        </body></html>
    `);
});

app.post('/admin/clear-history', authAdmin, async (req, res) => {
    try {
        await Bet.deleteMany({});
        await Game.deleteMany({ status: 'finalizado' });
        res.redirect('/admin/maintenance');
    } catch (error) {
        console.error("Erro ao limpar o histórico:", error);
        res.status(500).send("Ocorreu um erro ao tentar limpar o histórico.");
    }
});


app.post('/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin');
});

// ROTAS PARA GERIR UTILIZADORES
app.get('/admin/users', authAdmin, async (req, res) => {
    try {
        const users = await User.find({});
        const userRows = users.map(user => `
            <tr class="border-b">
                <td class="py-3 px-4">${user.name}</td>
                <td class="py-3 px-4">${user.pix}</td>
                <td class="py-3 px-4 text-center">
                    <a href="/admin/edit-user/${user._id}" class="bg-green-500 text-white font-bold py-1 px-3 rounded-md hover:bg-green-600 text-sm">Editar</a>
                </td>
            </tr>
        `).join('');

        res.send(`
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Gerir Utilizadores</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-4 md:p-8">
                <div class="container mx-auto bg-white p-6 rounded-lg shadow-md">
                    <div class="flex justify-between items-center mb-6">
                        <h1 class="text-3xl font-bold text-gray-800">Gerir Utilizadores</h1>
                        <a href="/admin/dashboard" class="bg-blue-500 text-white font-bold py-2 px-4 rounded-md hover:bg-blue-600">Voltar ao Dashboard</a>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="min-w-full bg-white">
                            <thead class="bg-gray-800 text-white">
                                <tr>
                                    <th class="py-3 px-4 text-left">Nome</th>
                                    <th class="py-3 px-4 text-left">Chave PIX</th>
                                    <th class="py-3 px-4 text-center">Ação</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${userRows}
                            </tbody>
                        </table>
                    </div>
                </div>
            </body></html>
        `);
    } catch (error) {
        res.status(500).send("Erro ao carregar utilizadores.");
    }
});

app.get('/admin/edit-user/:id', authAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).send('Utilizador não encontrado.');
        res.send(`
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Editar Utilizador</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-4 md:p-8">
                <div class="container mx-auto bg-white p-6 rounded-lg shadow-md max-w-lg">
                    <h1 class="text-3xl font-bold text-gray-800 mb-6">Editar Utilizador</h1>
                    <form action="/admin/edit-user/${user._id}" method="POST" class="space-y-4">
                        <div>
                            <label for="name" class="block font-semibold text-gray-700">Nome do Utilizador</label>
                            <input type="text" id="name" name="name" value="${user.name}" class="w-full p-2 border rounded-md mt-1" required>
                        </div>
                        <div>
                            <label for="pix" class="block font-semibold text-gray-700">Chave PIX</label>
                            <input type="text" id="pix" name="pix" value="${user.pix}" class="w-full p-2 border rounded-md mt-1" required>
                        </div>
                        <div class="flex justify-end space-x-4 pt-4">
                            <a href="/admin/users" class="bg-gray-300 text-gray-800 font-bold py-2 px-4 rounded-md hover:bg-gray-400">Cancelar</a>
                            <button type="submit" class="bg-blue-600 text-white font-bold py-2 px-4 rounded-md hover:bg-blue-700">Salvar Alterações</button>
                        </div>
                    </form>
                </div>
            </body></html>
        `);
    } catch (error) {
        res.status(500).send("Erro ao carregar dados do utilizador.");
    }
});

app.post('/admin/edit-user/:id', authAdmin, async (req, res) => {
    try {
        const { name, pix } = req.body;
        await User.findByIdAndUpdate(req.params.id, { name, pix });
        res.redirect('/admin/users');
    } catch (error) {
        res.status(500).send("Erro ao salvar as alterações.");
    }
});

app.get('/admin/games', authAdmin, async (req, res) => {
    try {
        const games = await Game.find().sort({ date: -1 });
        const gameRows = games.map(game => {
            const openControls = `<a href="/admin/edit-game/${game._id}" class="bg-blue-500 text-white px-3 py-1 rounded text-sm mr-2">Editar Jogo</a><form action="/admin/close-game/${game._id}" method="post" class="inline-block"><button class="bg-yellow-500 text-white px-3 py-1 rounded text-sm">Fechar Apostas</button></form>`;
            const closedControls = `<form action="/admin/finalize-game/${game._id}" method="post"><select name="result" class="p-2 border rounded"><option value="home">Vencedor: ${game.home.name}</option><option value="away">Vencedor: ${game.away.name}</option><option value="empate">Empate</option></select><button type="submit" class="bg-green-500 text-white px-3 py-1 rounded text-sm ml-2">Finalizar Jogo</button></form>`;
            return `
                <div class="border p-4 rounded-lg">
                    <p class="font-bold text-lg">${game.home.name} vs ${game.away.name}</p>
                    <p class="text-sm">Odds: Casa ${game.odds.home.toFixed(2)} | Empate ${game.odds.draw.toFixed(2)} | Visitante ${game.odds.away.toFixed(2)}</p>
                    <p>Status: <span class="font-semibold">${game.status}</span> | Resultado: <span class="font-semibold">${game.result}</span> | Limite Aposta: <span class="font-semibold">R$ ${game.maxBetValue.toFixed(2)}</span></p>
                    <div class="mt-2">
                        ${game.status === 'aberto' ? openControls : ''}
                        ${game.status === 'fechado' ? closedControls : ''}
                    </div>
                </div>`;
        }).join('');
        
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
                           <input type="number" step="0.01" name="max_bet_value" placeholder="Valor Máx. por Aposta (R$)" class="p-2 border rounded" value="35" required>
                        </div>
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
                <div class="space-y-4">${gameRows}</div></div></div></body></html>`);
    } catch (error) { res.status(500).send("Erro ao carregar jogos."); }
});

app.post('/admin/add-game', authAdmin, async (req, res) => {
    try {
        const { home_name, home_logo, away_name, away_logo, date, competition, odds_home, odds_draw, odds_away, max_bet_value } = req.body;
        const newGame = new Game({
            home: { name: home_name, logo: home_logo },
            away: { name: away_name, logo: away_logo },
            date, competition,
            odds: { home: parseFloat(odds_home), draw: parseFloat(odds_draw), away: parseFloat(odds_away) },
            initialOdds: { home: parseFloat(odds_home), draw: parseFloat(odds_draw), away: parseFloat(odds_away) },
            maxBetValue: parseFloat(max_bet_value)
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
            <html lang="pt-BR"><head><title>Editar Jogo</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto max-w-lg">
            <h1 class="text-3xl font-bold mb-6">Editar Jogo: ${game.home.name} vs ${game.away.name}</h1>
            <div class="bg-white p-6 rounded shadow-md">
                <form action="/admin/edit-game/${game._id}" method="post" class="space-y-4">
                    <div><label class="block font-semibold">Valor Máx. por Aposta (R$)</label><input type="number" step="0.01" name="max_bet_value" value="${game.maxBetValue}" class="w-full p-2 border rounded" required></div>
                    <hr/>
                    <h3 class="font-bold text-lg pt-2">Odds</h3>
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
        const { odds_home, odds_draw, odds_away, max_bet_value } = req.body;
        await Game.findByIdAndUpdate(req.params.id, {
            $set: {
                'odds.home': parseFloat(odds_home),
                'odds.draw': parseFloat(odds_draw),
                'odds.away': parseFloat(odds_away),
                'maxBetValue': parseFloat(max_bet_value)
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

