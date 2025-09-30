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

// Schema do Jogo ATUALIZADO para incluir novos mercados de aposta
const GameSchema = new mongoose.Schema({
    home: { name: String, logo: String },
    away: { name: String, logo: String },
    date: String,
    competition: String,
    status: { type: String, enum: ['aberto', 'fechado', 'finalizado'], default: 'aberto' },
    // Resultados ATUALIZADOS para os novos mercados
    result: {
        final: { type: String, enum: ['home', 'away', 'empate', 'pendente'], default: 'pendente' },
        goalsOver25: { type: String, enum: ['sim', 'nao', 'pendente'], default: 'pendente' },
        bothTeamsScore: { type: String, enum: ['sim', 'nao', 'pendente'], default: 'pendente' }
    },
    // Odds ATUALIZADAS para incluir os novos mercados
    odds: {
        home: { type: Number, default: 1.5 },
        away: { type: Number, default: 1.5 },
        draw: { type: Number, default: 1.5 },
        over25: { type: Number, default: 1.8 }, // Total de Golos (Mais de 2.5)
        under25: { type: Number, default: 1.8 }, // Total de Golos (Menos de 2.5)
        btsYes: { type: Number, default: 1.7 }, // Ambas as Equipas Marcam (Sim)
        btsNo: { type: Number, default: 1.7 } // Ambas as Equipas Marcam (Não)
    },
    initialOdds: {
        home: { type: Number }, away: { type: Number }, draw: { type: Number },
        over25: { type: Number }, under25: { type: Number },
        btsYes: { type: Number }, btsNo: { type: Number }
    },
    maxBetValue: { type: Number, default: 35 }
});
const Game = mongoose.model('Game', GameSchema);

// Schema da Aposta REFEITO para suportar apostas simples e múltiplas
const BetSchema = new mongoose.Schema({
    selections: [{
        gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
        gameTitle: String,
        betType: String, // e.g., 'RESULTADO_FINAL', 'GOLOS_MAIS_2_5', 'AMBAS_MARCAM'
        betChoice: String, // e.g., 'home', 'sim'
        odds: Number,
        status: { type: String, enum: ['pendente', 'ganhou', 'perdeu', 'anulada'], default: 'pendente' }
    }],
    totalOdds: { type: Number, required: true },
    betValue: Number,
    user: { name: String, pix: String },
    status: { type: String, default: 'aprovada' }, // Status geral da aposta múltipla
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

// --- Função para Odds Dinâmicas (Focada no mercado principal) ---
async function updateOdds(gameId) {
    try {
        // ... (a lógica de odds dinâmicas existente permanece focada no mercado 1x2 por simplicidade)
        // A expansão para outros mercados pode ser feita futuramente se necessário.
    } catch (error) {
        console.error(`Erro ao atualizar odds para o jogo ${gameId}:`, error);
    }
}


// --- ROTAS PÚBLICAS (para o site principal) ---
app.get('/', (req, res) => res.send('<h1>Servidor do AgroBet está no ar!</h1>'));
app.post('/login', async (req, res) => { /* ... (código existente sem alterações) */ });
app.post('/register', async (req, res) => { /* ... (código existente sem alterações) */ });

app.get('/games', async (req, res) => {
    try {
        const openGames = await Game.find({ status: 'aberto' }).sort({ date: 1 });
        res.json(openGames);
    } catch (error) { res.status(500).json({ message: "Erro ao buscar jogos." }); }
});

// Rota de pagamento ATUALIZADA para aceitar apostas múltiplas
app.post('/criar-pagamento', async (req, res) => {
    const { selections, value, user } = req.body;

    if (!selections || selections.length === 0 || !value || !user) {
        return res.status(400).json({ message: 'Dados da aposta incompletos.' });
    }

    try {
        let totalOdds = 1;
        let gameIdsToUpdate = new Set();
        const DYNAMIC_LIMIT_ODD_THRESHOLD = 1.30;
        const DYNAMIC_LIMIT_VALUE = 5.00;

        for (const selection of selections) {
            const game = await Game.findById(selection.gameId);
            if (!game || game.status !== 'aberto') {
                return res.status(400).json({ message: `O jogo "${selection.gameTitle}" não está mais aberto para apostas.` });
            }

            // PRIORIDADE 3: Implementação do Limite Dinâmico
            if (selection.odds < DYNAMIC_LIMIT_ODD_THRESHOLD && value > DYNAMIC_LIMIT_VALUE) {
                return res.status(400).json({ message: `Para odds abaixo de ${DYNAMIC_LIMIT_ODD_THRESHOLD}, a aposta máxima é de R$ ${DYNAMIC_LIMIT_VALUE.toFixed(2)}.` });
            }
            
            // Verifica o limite de aposta individual por jogo do utilizador
            const userBetsOnGame = await Bet.find({ 'user.pix': user.pix, 'selections.gameId': game._id });
            const totalBetByUser = userBetsOnGame.reduce((acc, bet) => acc + bet.betValue, 0);
            if ((totalBetByUser + value) > game.maxBetValue) {
                 return res.status(400).json({ message: `Já atingiu o seu limite de aposta para o jogo ${game.home.name} vs ${game.away.name}.` });
            }

            totalOdds *= selection.odds;
            gameIdsToUpdate.add(selection.gameId);
        }

        const potentialPayout = value * totalOdds;
        const description = selections.length > 1 ? `${selections.length} seleções` : selections[0].betChoice;

        const preferenceData = {
            body: {
                items: [{
                    id: new mongoose.Types.ObjectId().toString(),
                    title: `Aposta Múltipla (${selections.length}x)`,
                    description: description,
                    quantity: 1,
                    unit_price: Number(value),
                    currency_id: 'BRL'
                }],
                back_urls: { success: process.env.SUCCESS_REDIRECT_URL, failure: process.env.FRONTEND_URL, pending: process.env.FRONTEND_URL },
                auto_return: 'approved',
                notification_url: `${process.env.SERVER_URL}/webhook-mercadopago`,
                metadata: {
                    user_pix: user.pix, user_name: user.name,
                    bet_value: value, total_odds: totalOdds,
                    potential_payout: potentialPayout,
                    selections: JSON.stringify(selections) // Guarda as seleções em JSON
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

// Webhook ATUALIZADO para processar a nova estrutura de apostas
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
                    status: 'aprovada',
                    potentialPayout: metadata.potential_payout,
                    date: new Date()
                });
                await newBet.save();

                // Atualiza as odds dinâmicas para os jogos envolvidos
                const gameIds = new Set(newBet.selections.map(s => s.gameId));
                gameIds.forEach(gameId => updateOdds(gameId));
            }
        }
        res.sendStatus(200);
    } catch (error) { res.sendStatus(500); }
});

// ... (rotas /my-bets/:pix e /results precisam de pequenas adaptações para o novo schema, não incluídas por brevidade)


// --- ROTAS DO PAINEL DE ADMINISTRAÇÃO ---
// ... (rotas /admin, /admin/login, /admin/dashboard sem alterações)

// Painel de jogos ATUALIZADO para adicionar e gerir novos mercados
app.get('/admin/games', authAdmin, async (req, res) => {
    try {
        const games = await Game.find().sort({ date: -1 });
        // O HTML agora inclui campos para as novas odds
        res.send(`<!DOCTYPE html><html lang="pt-BR"><head><title>Gerir Jogos</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto"><h1 class="text-3xl font-bold mb-6">Gerir Jogos</h1>
            <div class="bg-white p-6 rounded shadow-md mb-8">
                <h2 class="text-2xl font-semibold mb-4">Adicionar Novo Jogo</h2>
                <form action="/admin/add-game" method="post" class="space-y-4">
                    <!-- ... campos de info do jogo ... -->
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
                    <!-- ... -->
                    <button type="submit" class="w-full bg-blue-500 text-white p-3 rounded hover:bg-blue-600 font-bold">Adicionar Jogo</button>
                </form>
            </div>
            <div class="bg-white p-6 rounded shadow-md">
                <h2 class="text-2xl font-semibold mb-4">Jogos Existentes</h2>
                ${games.map(game => `
                    <div class="border p-4 rounded-lg mb-4">
                        <p class="font-bold text-lg">${game.home.name} vs ${game.away.name}</p>
                        <p>Status: <span class="font-semibold">${game.status}</span></p>
                        ${game.status === 'fechado' ? `
                        <form action="/admin/finalize-game/${game._id}" method="post" class="mt-2 space-y-2">
                            <h4 class="font-bold">Definir Resultados:</h4>
                            <div><label>Resultado Final:</label> <select name="result_final" class="p-1 border rounded"><option value="home">Vencedor: ${game.home.name}</option><option value="away">Vencedor: ${game.away.name}</option><option value="empate">Empate</option></select></div>
                            <div><label>Golos > 2.5:</label> <select name="result_goalsOver25" class="p-1 border rounded"><option value="sim">Sim</option><option value="nao">Não</option></select></div>
                            <div><label>Ambas Marcam:</label> <select name="result_bothTeamsScore" class="p-1 border rounded"><option value="sim">Sim</option><option value="nao">Não</option></select></div>
                            <button type="submit" class="bg-green-500 text-white px-3 py-1 rounded text-sm">Finalizar Jogo</button>
                        </form>` : ''}
                        ${game.status === 'aberto' ? `<form action="/admin/close-game/${game._id}" method="post" class="inline-block mt-2"><button class="bg-yellow-500 text-white px-3 py-1 rounded text-sm">Fechar Apostas</button></form>` : ''}
                    </div>`).join('')}
            </div></div></body></html>`);
    } catch (error) { res.status(500).send("Erro ao carregar jogos."); }
});

// Rota para adicionar jogo ATUALIZADA com os novos mercados
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
            date, competition,
            odds: odds,
            initialOdds: odds, // Salva as odds iniciais
            maxBetValue: parseFloat(max_bet_value)
        });
        await newGame.save();
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao adicionar jogo."); }
});

// Rota para finalizar jogo ATUALIZADA com os novos mercados
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
        // A lógica de calcular os vencedores das apostas múltiplas seria acionada aqui
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao finalizar jogo."); }
});


// ... (outras rotas de admin existentes)

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

