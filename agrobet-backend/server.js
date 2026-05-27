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
    initialOdds: { // Guarda as odds originais para um cÃ¡lculo mais estÃ¡vel
        home: { type: Number },
        away: { type: Number },
        draw: { type: Number }
    },
    maxBetValue: { type: Number, default: 35 } // Limite de valor por aposta
});
const Game = mongoose.model('Game', GameSchema);

const BetSchema = new mongoose.Schema({
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
    paymentId: { type: String, unique: true, sparse: true, index: true },
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

// --- ConexÃ£o e ConfiguraÃ§Ã£o do Servidor ---
mongoose.connect(process.env.MONGODB_URI).then(() => console.log("MongoDB conectado.")).catch(err => console.error(err));
const app = express();
app.disable('x-powered-by');

const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const corsOptions = {
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origem nÃ£o permitida pelo CORS.'));
    },
    credentials: true
};
app.use(cors(corsOptions));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});
app.use(bodyParser.json({ limit: '80kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '80kb' }));
app.use(cookieParser());
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const preference = new Preference(client);
const payment = new Payment(client);

const VALID_BET_OPTIONS = new Set(['home', 'away', 'empate']);
const OUTCOMES = ['home', 'draw', 'away'];
const ODDS_POLICY = {
    houseMargin: Number(process.env.ODDS_HOUSE_MARGIN || 0.30),
    minOdd: Number(process.env.ODDS_MIN || 1.03),
    maxOdd: Number(process.env.ODDS_MAX || 2.60),
    startingPool: Number(process.env.ODDS_STARTING_POOL || 20),
    maturityPool: Number(process.env.ODDS_MATURITY_POOL || 160),
    highConcentrationShare: Number(process.env.ODDS_HIGH_CONCENTRATION_SHARE || 0.62),
    hardConcentrationShare: Number(process.env.ODDS_HARD_CONCENTRATION_SHARE || 0.72),
    marketStakeMultiplier: Number(process.env.RISK_MARKET_STAKE_MULTIPLIER || 8),
    outcomeStakeMultiplier: Number(process.env.RISK_OUTCOME_STAKE_MULTIPLIER || 4),
    liabilityPoolMultiplier: Number(process.env.RISK_LIABILITY_POOL_MULTIPLIER || 1.08),
    startingLiabilityMultiplier: Number(process.env.RISK_STARTING_LIABILITY_MULTIPLIER || 2.80)
};
const DEFAULT_ADMIN_PASSWORD = '07042007pv';
const JWT_SECRET = process.env.JWT_SECRET || 'agrobet-admin-local-secret';

function cleanText(value, maxLength = 140) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function toMoney(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return null;
    return Math.round(numericValue * 100) / 100;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function optionToOutcome(option) {
    return option === 'empate' ? 'draw' : option;
}

function betChoiceToOutcome(betChoice, game) {
    if (betChoice === 'Empate') return 'draw';
    if (betChoice === game.home.name) return 'home';
    if (betChoice === game.away.name) return 'away';
    return null;
}

function getMarketSnapshot(game, bets) {
    const stakes = { home: 0, draw: 0, away: 0 };
    const liabilities = { home: 0, draw: 0, away: 0 };

    bets.forEach(bet => {
        const outcome = betChoiceToOutcome(bet.betChoice, game);
        if (!outcome) return;
        stakes[outcome] += Number(bet.betValue || 0);
        liabilities[outcome] += Number(bet.potentialPayout || 0);
    });

    const totalStake = OUTCOMES.reduce((sum, outcome) => sum + stakes[outcome], 0);
    return { stakes, liabilities, totalStake };
}

function normalizedInitialProbabilities(initialOdds) {
    const implied = {
        home: 1 / Math.max(Number(initialOdds?.home || 2), 1.01),
        draw: 1 / Math.max(Number(initialOdds?.draw || 3), 1.01),
        away: 1 / Math.max(Number(initialOdds?.away || 2), 1.01)
    };
    const total = OUTCOMES.reduce((sum, outcome) => sum + implied[outcome], 0);
    return {
        home: implied.home / total,
        draw: implied.draw / total,
        away: implied.away / total
    };
}

function calculateManagedOdds(game, bets) {
    const { stakes, totalStake } = getMarketSnapshot(game, bets);
    const baseProbability = normalizedInitialProbabilities(game.initialOdds || game.odds);
    const moneyWeight = totalStake < ODDS_POLICY.startingPool
        ? 0
        : clamp((totalStake - ODDS_POLICY.startingPool) / ODDS_POLICY.maturityPool, 0, 0.75);

    const liquiditySeed = Math.max(Number(game.maxBetValue || 35) * 0.75, 20);
    const seededPool = totalStake + (liquiditySeed * OUTCOMES.length);
    const odds = {};

    OUTCOMES.forEach(outcome => {
        const moneyPressure = (stakes[outcome] + liquiditySeed) / seededPool;
        const probability = (baseProbability[outcome] * (1 - moneyWeight)) + (moneyPressure * moneyWeight);
        const outcomeShare = totalStake > 0 ? stakes[outcome] / totalStake : 0;
        let maxOdd = ODDS_POLICY.maxOdd;

        if (outcomeShare >= ODDS_POLICY.hardConcentrationShare) {
            maxOdd = Math.min(maxOdd, 1.28);
        } else if (outcomeShare >= ODDS_POLICY.highConcentrationShare) {
            maxOdd = Math.min(maxOdd, 1.45);
        }

        odds[outcome] = toMoney(clamp((1 - ODDS_POLICY.houseMargin) / probability, ODDS_POLICY.minOdd, maxOdd));
    });

    return odds;
}

function assessBetRisk(game, approvedBets, option, value, odds) {
    const outcome = optionToOutcome(option);
    const snapshot = getMarketSnapshot(game, approvedBets);
    const projectedStake = snapshot.stakes[outcome] + value;
    const projectedTotalStake = snapshot.totalStake + value;
    const projectedShare = projectedTotalStake > 0 ? projectedStake / projectedTotalStake : 0;
    const projectedLiability = snapshot.liabilities[outcome] + (value * odds);
    const maxBetValue = Number(game.maxBetValue || 35);
    const maxMarketStake = maxBetValue * ODDS_POLICY.marketStakeMultiplier;
    const maxOutcomeStake = maxBetValue * ODDS_POLICY.outcomeStakeMultiplier;
    const liabilityBudget = Math.max(
        maxBetValue * ODDS_POLICY.startingLiabilityMultiplier,
        projectedTotalStake * ODDS_POLICY.liabilityPoolMultiplier
    );

    if (projectedTotalStake > maxMarketStake) {
        return { ok: false, message: 'Mercado temporariamente limitado: o volume total deste jogo jÃ¡ atingiu o limite de seguranÃ§a.' };
    }

    if (projectedStake > maxOutcomeStake) {
        return { ok: false, message: 'Mercado temporariamente limitado: jÃ¡ entrou muito dinheiro nesse palpite.' };
    }

    if (projectedTotalStake >= maxBetValue * 2 && projectedShare >= ODDS_POLICY.hardConcentrationShare) {
        return { ok: false, message: 'Mercado temporariamente limitado: concentraÃ§Ã£o muito alta em um dos lados.' };
    }

    if (projectedLiability > liabilityBudget) {
        return { ok: false, message: 'Mercado temporariamente limitado: exposiÃ§Ã£o mÃ¡xima da casa atingida para este resultado.' };
    }

    return { ok: true };
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function adminPage(title, content, active = 'dashboard') {
    const navItems = [
        { key: 'dashboard', label: 'Painel', href: '/admin/dashboard' },
        { key: 'games', label: 'Jogos', href: '/admin/games' },
        { key: 'report', label: 'Apostas', href: '/relatorio', target: '_blank' },
        { key: 'finance', label: 'Financeiro', href: '/admin/financial-report', target: '_blank' },
        { key: 'payments', label: 'Pagamentos', href: '/admin/payment-summary', target: '_blank' }
    ];

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} | AgroBet Admin</title>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f3f5f1; color: #172019; }
        a { color: inherit; text-decoration: none; }
        button, input, select { font: inherit; }
        .admin-shell { min-height: 100vh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
        .sidebar { position: sticky; top: 0; height: 100vh; padding: 18px; background: #132018; color: #edf5ee; border-right: 1px solid #26382d; }
        .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
        .brand-mark { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 8px; background: #35b768; color: #07110b; font-weight: 900; }
        .brand b { display: block; color: #f5d45f; }
        .brand span { display: block; color: #9fb0a5; font-size: 12px; margin-top: 2px; }
        .nav { display: grid; gap: 6px; }
        .nav a, .logout button { width: 100%; min-height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: #cbd8cf; font-weight: 700; }
        .nav a.active, .nav a:hover, .logout button:hover { background: #213127; border-color: #31463a; color: #fff; }
        .logout { margin-top: 18px; padding-top: 18px; border-top: 1px solid #2b3e32; }
        .logout button { cursor: pointer; color: #ffd8d8; }
        .content { min-width: 0; padding: 24px; }
        .topline { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 18px; }
        h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
        .muted { color: #66736a; }
        .grid { display: grid; gap: 14px; }
        .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .card { border: 1px solid #dce3dd; border-radius: 8px; background: #fff; box-shadow: 0 10px 30px rgba(24, 32, 27, 0.06); }
        .card-pad { padding: 16px; }
        .stat b { display: block; font-size: 28px; margin-bottom: 4px; }
        .stat span { color: #65726a; font-size: 13px; font-weight: 700; }
        .actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .action { min-height: 96px; display: grid; align-content: center; gap: 6px; padding: 16px; border-radius: 8px; background: #17231c; color: #fff; }
        .action b { color: #f5d45f; }
        .action span { color: #b6c2ba; font-size: 13px; }
        .split { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; align-items: start; }
        .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #e2e8e3; }
        .section-title h2 { margin: 0; font-size: 17px; }
        .table-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { text-align: left; color: #65726a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; background: #f7f9f7; }
        th, td { padding: 11px 12px; border-bottom: 1px solid #e7ece8; vertical-align: middle; }
        tr:hover td { background: #fafcf9; }
        .pill { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 800; background: #e9eee9; color: #334039; }
        .pill.open { background: #dff8e9; color: #126438; }
        .pill.closed { background: #fff1cf; color: #8a5a00; }
        .pill.done { background: #e8ebff; color: #384095; }
        .form-grid { display: grid; gap: 10px; }
        .form-row { display: grid; gap: 6px; }
        label { font-size: 12px; color: #65726a; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
        input, select { width: 100%; min-height: 40px; border: 1px solid #d9e0db; border-radius: 7px; padding: 0 11px; background: #fff; color: #152019; outline: none; }
        input:focus, select:focus { border-color: #35b768; box-shadow: 0 0 0 3px rgba(53, 183, 104, 0.12); }
        .cols-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        .cols-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
        .btn { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 7px; padding: 0 13px; background: #35b768; color: #07110b; font-weight: 900; cursor: pointer; }
        .btn.secondary { background: #17231c; color: #fff; }
        .btn.warn { background: #f5d45f; color: #15170f; }
        .btn.danger { background: #d63d3d; color: #fff; }
        .inline-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
        .danger-zone { margin-top: 18px; border-color: #ffd3d3; background: #fff9f9; }
        @media (max-width: 1000px) { .admin-shell { grid-template-columns: 1fr; } .sidebar { position: static; height: auto; } .split, .stats, .actions { grid-template-columns: 1fr; } .content { padding: 16px; } }
    </style>
</head>
<body>
    <div class="admin-shell">
        <aside class="sidebar">
            <div class="brand"><div class="brand-mark">A</div><div><b>AgroBet Admin</b><span>OperaÃ§Ã£o e risco</span></div></div>
            <nav class="nav">${navItems.map(item => `<a class="${active === item.key ? 'active' : ''}" href="${item.href}" ${item.target ? `target="${item.target}"` : ''}><span>${item.label}</span><span>â€º</span></a>`).join('')}</nav>
            <form class="logout" action="/admin/logout" method="post"><button type="submit">Sair <span>â€º</span></button></form>
        </aside>
        <main class="content">${content}</main>
    </div>
</body>
</html>`;
}

// --- Middleware de AutenticaÃ§Ã£o do Admin ---
const authAdmin = (req, res, next) => {
    const token = req.cookies.admin_token;
    if (!token) return res.redirect('/admin');
    try {
        jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        return res.redirect('/admin');
    }
};

// --- FunÃ§Ã£o para Odds DinÃ¢micas (LÃ“GICA AJUSTADA) ---
async function updateOdds(gameId) {
    try {
        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto' || !game.initialOdds) return;

        const bets = await Bet.find({ gameId: gameId, status: 'approved' }).lean();
        const newOdds = calculateManagedOdds(game, bets);

        await Game.findByIdAndUpdate(gameId, {
            $set: {
                'odds.home': newOdds.home,
                'odds.away': newOdds.away,
                'odds.draw': newOdds.draw,
            }
        });

        console.log(`Odds atualizadas para o jogo ${game._id}: C:${newOdds.home.toFixed(2)}, E:${newOdds.draw.toFixed(2)}, V:${newOdds.away.toFixed(2)}`);

    } catch (error) {
        console.error(`Erro ao atualizar odds para o jogo ${gameId}:`, error);
    }
}

// --- ROTAS PÃšBLICAS (para o site principal) ---
app.get('/', (req, res) => res.send('<h1>Servidor do AgroBet estÃ¡ no ar!</h1>'));

app.post('/login', async (req, res) => {
    try {
        const pix = cleanText(req.body.pix, 180);
        const password = String(req.body.password || '');
        if (!pix || !password) {
            return res.status(400).json({ success: false, message: 'Informe PIX e senha.' });
        }
        const user = await User.findOne({ pix });
        if (!user) return res.status(404).json({ success: false, message: 'Utilizador nÃ£o encontrado.' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ success: false, message: 'Senha incorreta.' });
        res.json({ success: true, user: { name: user.name, pix: user.pix } });
    } catch (error) { res.status(500).json({ success: false, message: 'Erro no servidor.' }); }
});

app.post('/register', async (req, res) => {
    try {
        const name = cleanText(req.body.name, 90);
        const pix = cleanText(req.body.pix, 180);
        const password = String(req.body.password || '');
        if (!name || !pix || password.length < 6) {
            return res.status(400).json({ success: false, message: 'Nome, PIX e senha com pelo menos 6 caracteres sÃ£o obrigatÃ³rios.' });
        }
        let user = await User.findOne({ pix });
        if (user) return res.status(400).json({ success: false, message: 'Esta chave PIX jÃ¡ estÃ¡ registada.' });
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
    try {
        const { gameId, option, user } = req.body;
        const value = toMoney(req.body.value);
        const userPix = cleanText(user?.pix, 180);

        if (!mongoose.Types.ObjectId.isValid(gameId)) {
            return res.status(400).json({ message: 'Jogo invÃ¡lido.' });
        }
        if (!VALID_BET_OPTIONS.has(option)) {
            return res.status(400).json({ message: 'Palpite invÃ¡lido.' });
        }
        if (!value || value <= 0) {
            return res.status(400).json({ message: 'Informe um valor de aposta vÃ¡lido.' });
        }
        if (!userPix) {
            return res.status(401).json({ message: 'FaÃ§a login para apostar.' });
        }

        const registeredUser = await User.findOne({ pix: userPix }).lean();
        if (!registeredUser) {
            return res.status(401).json({ message: 'UsuÃ¡rio nÃ£o encontrado. FaÃ§a login novamente.' });
        }

        const game = await Game.findById(gameId);
        if (!game || game.status !== 'aberto') {
            return res.status(400).json({ message: 'Este jogo nÃ£o estÃ¡ mais aberto para apostas.' });
        }
        
        const approvedBetsForGame = await Bet.find({ gameId: gameId, status: 'approved' }).lean();
        const userBetsOnGame = approvedBetsForGame.filter(bet => bet.user?.pix === registeredUser.pix);
        const totalBetByUser = userBetsOnGame.reduce((acc, bet) => acc + Number(bet.betValue || 0), 0);

        if ((totalBetByUser + value) > game.maxBetValue) {
            const remainingValue = game.maxBetValue - totalBetByUser;
            if (remainingValue <= 0) {
                return res.status(400).json({ message: `JÃ¡ atingiu o seu limite de aposta de R$ ${game.maxBetValue.toFixed(2)} para este jogo.` });
            }
            return res.status(400).json({ message: `O seu limite total para este jogo Ã© R$ ${game.maxBetValue.toFixed(2)}. Ainda pode apostar atÃ© R$ ${remainingValue.toFixed(2)}.` });
        }


        const oddsKey = option === 'empate' ? 'draw' : option;
        const managedOdds = calculateManagedOdds(game, approvedBetsForGame);
        const odds = Number(managedOdds[oddsKey]);
        if (!Number.isFinite(odds) || odds <= 0) {
            return res.status(400).json({ message: 'Odd invÃ¡lida para este jogo.' });
        }
        await Game.findByIdAndUpdate(gameId, {
            $set: {
                'odds.home': managedOdds.home,
                'odds.away': managedOdds.away,
                'odds.draw': managedOdds.draw,
            }
        });
        const potentialPayout = toMoney(value * odds);
        const risk = assessBetRisk(game, approvedBetsForGame, option, value, odds);
        if (!risk.ok) {
            await updateOdds(gameId);
            return res.status(400).json({ message: risk.message });
        }
        const betChoiceText = option === 'empate' ? 'Empate' : game[option].name;
        
        const redirectUrl = process.env.SUCCESS_REDIRECT_URL || allowedOrigins[0] || req.get('origin');
        const serverUrl = process.env.SERVER_URL;
        if (!redirectUrl || !serverUrl) {
            return res.status(500).json({ message: 'ConfiguraÃ§Ã£o de URLs do servidor incompleta.' });
        }

        const preferenceData = {
            body: {
                items: [{
                    id: gameId,
                    title: `Aposta: ${game.home.name} vs ${game.away.name}`,
                    description: `Palpite: ${betChoiceText}`,
                    quantity: 1,
                    unit_price: value,
                    currency_id: 'BRL'
                }],
                back_urls: { success: redirectUrl, failure: redirectUrl, pending: redirectUrl },
                auto_return: 'approved', 
                notification_url: `${serverUrl}/webhook-mercadopago`,
                metadata: {
                    game_id: gameId, user_pix: registeredUser.pix, user_name: registeredUser.name,
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
        if (req.body.type === 'payment' && req.body.data?.id) {
            const paymentDetails = await payment.get({ id: req.body.data.id });
            if (paymentDetails.status === 'approved') {
                const paymentId = String(paymentDetails.id || req.body.data.id);
                const existingBet = await Bet.findOne({ paymentId });
                if (existingBet) return res.sendStatus(200);

                const metadata = paymentDetails.metadata;
                const game = await Game.findById(metadata.game_id);
                const newBet = new Bet({
                    paymentId,
                    gameId: metadata.game_id,
                    gameTitle: game ? `${game.home.name} vs ${game.away.name}` : 'Jogo Desconhecido',
                    betChoice: metadata.bet_choice, betValue: Number(metadata.bet_value),
                    date: new Date(), user: { name: metadata.user_name, pix: metadata.user_pix },
                    status: 'approved', odds: Number(metadata.odds), potentialPayout: Number(metadata.potential_payout)
                });
                await newBet.save();
                await updateOdds(metadata.game_id);
            }
        }
        res.sendStatus(200);
    } catch (error) { res.sendStatus(500); }
});

app.get('/my-bets/:pix', async (req, res) => {
    try {
        const pix = cleanText(req.params.pix, 180);
        if (!pix) return res.status(400).json({ success: false, message: 'PIX invÃ¡lido.' });
        const bets = await Bet.find({ 'user.pix': pix, status: 'approved' }).sort({ date: -1 });
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
        let html = `
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>RelatÃ³rio de Apostas</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="container mx-auto bg-white p-6 rounded-lg shadow-md">
            <h1 class="text-3xl font-bold mb-6 text-gray-800">RelatÃ³rio de Apostas Confirmadas</h1><div class="overflow-x-auto">
            <table class="min-w-full bg-white"><thead class="bg-gray-800 text-white">
            <tr><th class="py-3 px-4 text-left">Data</th><th class="py-3 px-4 text-left">Utilizador</th><th class="py-3 px-4 text-left">Jogo</th><th class="py-3 px-4 text-left">Palpite</th><th class="py-3 px-4 text-left">Valor</th><th class="py-3 px-4 text-left">Odd</th><th class="py-3 px-4 text-left">Retorno Pot.</th></tr>
            </thead><tbody>`;
        bets.forEach(bet => {
            html += `<tr class="border-b"><td class="py-3 px-4">${new Date(bet.date).toLocaleString('pt-BR')}</td><td class="py-3 px-4">${bet.user.name}</td><td class="py-3 px-4">${bet.gameTitle}</td><td class="py-3 px-4">${bet.betChoice}</td><td class="py-3 px-4">R$ ${bet.betValue.toFixed(2)}</td><td class="py-3 px-4">${bet.odds.toFixed(2)}</td><td class="py-3 px-4 font-semibold text-green-700">R$ ${bet.potentialPayout.toFixed(2)}</td></tr>`;
        });
        html += `</tbody></table></div></div></body></html>`;
        res.send(html);
    } catch (error) { res.status(500).send("Erro ao gerar o relatÃ³rio."); }
});


// --- ROTAS DO PAINEL DE ADMINISTRAÃ‡ÃƒO ---
app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin | AgroBet</title>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 18px; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top left, rgba(53,183,104,.18), transparent 28rem), #101713; color: #f3f8f4; }
        .login { width: min(100%, 390px); border: 1px solid #2d3d33; border-radius: 10px; background: #17231c; box-shadow: 0 24px 80px rgba(0,0,0,.32); overflow: hidden; }
        .head { padding: 22px; border-bottom: 1px solid #2d3d33; }
        .head b { display: block; color: #f5d45f; font-size: 22px; }
        .head span { display: block; margin-top: 5px; color: #a8b8ad; font-size: 14px; }
        form { display: grid; gap: 12px; padding: 22px; }
        label { color: #a8b8ad; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
        input { width: 100%; height: 44px; border: 1px solid #34473b; border-radius: 7px; background: #0f1712; color: #fff; padding: 0 12px; outline: 0; }
        input:focus { border-color: #35b768; box-shadow: 0 0 0 3px rgba(53,183,104,.13); }
        button { height: 44px; border: 0; border-radius: 7px; background: #f5d45f; color: #11170f; font-weight: 900; cursor: pointer; }
        .hint { color: #7f9286; font-size: 12px; line-height: 1.5; }
    </style>
</head>
<body>
    <section class="login">
        <div class="head"><b>AgroBet Admin</b><span>Acesso operacional da plataforma</span></div>
        <form action="/admin/login" method="post">
            <label for="password">Senha administrativa</label>
            <input id="password" type="password" name="password" placeholder="Digite a senha" autocomplete="current-password" required autofocus>
            <button type="submit">Entrar no painel</button>
            <div class="hint">Use a senha configurada no Render. Se ADMIN_PASSWORD nÃ£o estiver definida, vale a senha padrÃ£o do sistema.</div>
        </form>
    </section>
</body>
</html>`);
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    if (password === adminPassword) {
        const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '1h' });
        res.cookie('admin_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 3600000
        });
        res.redirect('/admin/dashboard');
    } else {
        res.status(401).send(adminPage('Senha incorreta', '<div class="topline"><div><h1>Senha incorreta</h1><p class="muted">Confira a senha e tente novamente.</p></div><a class="btn secondary" href="/admin">Voltar</a></div>'));
    }
});

app.get('/admin/dashboard', authAdmin, async (req, res) => {
    try {
        const [openGames, closedGames, finalizedGames, approvedBets, users] = await Promise.all([
            Game.countDocuments({ status: 'aberto' }),
            Game.countDocuments({ status: 'fechado' }),
            Game.countDocuments({ status: 'finalizado' }),
            Bet.countDocuments({ status: 'approved' }),
            User.countDocuments()
        ]);

        const content = `
            <div class="topline">
                <div><h1>Painel de operação</h1><p class="muted">Atalhos e indicadores para administrar a rodada com rapidez.</p></div>
                <a class="btn" href="/admin/games">Gerir jogos</a>
            </div>
            <section class="grid stats">
                <div class="card card-pad stat"><b>${openGames}</b><span>Jogos abertos</span></div>
                <div class="card card-pad stat"><b>${closedGames}</b><span>Aguardando resultado</span></div>
                <div class="card card-pad stat"><b>${approvedBets}</b><span>Apostas confirmadas</span></div>
                <div class="card card-pad stat"><b>${users}</b><span>Usuários cadastrados</span></div>
            </section>
            <section class="grid actions" style="margin-top:14px">
                <a class="action" href="/admin/games"><b>Jogos e odds</b><span>Criar partidas, editar limites, fechar apostas e finalizar resultados.</span></a>
                <a class="action" href="/admin/financial-report" target="_blank"><b>Financeiro</b><span>Ver saldo, ganhadores, perdas e exportar CSV.</span></a>
                <a class="action" href="/admin/payment-summary" target="_blank"><b>Pagamentos</b><span>Total consolidado por pessoa para pagar via PIX.</span></a>
            </section>
            <section class="card danger-zone card-pad">
                <div class="topline" style="margin:0">
                    <div><h2 style="margin:0;font-size:18px;color:#9b1c1c">Ações irreversíveis</h2><p class="muted">Use apenas quando a rodada antiga já foi conferida.</p></div>
                    <form action="/admin/clear-history" method="post" onsubmit="return confirm('Tem certeza de que deseja limpar TODO o histórico de apostas e jogos finalizados? Esta ação não pode ser desfeita.');">
                        <button type="submit" class="btn danger">Limpar histórico antigo</button>
                    </form>
                </div>
            </section>
        `;

        res.send(adminPage('Painel', content, 'dashboard'));
    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
        res.status(500).send('Erro ao carregar painel administrativo.');
    }
});
app.get('/admin/financial-report', authAdmin, async (req, res) => {
    try {
        const bets = await Bet.find({ status: 'approved' }).populate('gameId').lean();
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

                if (gameResult === 'empate' && betChoice === 'Empate') {
                    isWinner = true;
                } else if (gameResult === 'home' && betChoice === game.home.name) {
                    isWinner = true;
                } else if (gameResult === 'away' && betChoice === game.away.name) {
                    isWinner = true;
                }
                
                let resultText = 'Pendente';
                 if (game.result === 'home') resultText = `Vencedor: ${game.home.name}`;
                 else if (game.result === 'away') resultText = `Vencedor: ${game.away.name}`;
                 else if (game.result === 'empate') resultText = 'Empate';

                reportData.push({
                    ...bet,
                    gameResult: resultText,
                    betStatus: isWinner ? 'Ganhou' : 'Perdeu',
                    amountToPay: isWinner ? bet.potentialPayout : 0,
                });

                if (isWinner) {
                    totalToPay += bet.potentialPayout;
                } else {
                    totalLostValue += bet.betValue;
                }
            }
        }
        
        const balance = totalLostValue - totalToPay;

        res.send(`
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>RelatÃ³rio Financeiro</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-4 md:p-8">
                <div class="container mx-auto bg-white p-6 rounded-lg shadow-md">
                    <div class="flex flex-wrap justify-between items-center mb-6">
                        <h1 class="text-3xl font-bold text-gray-800">RelatÃ³rio Financeiro Detalhado</h1>
                        <div>
                            <a href="/admin/payment-summary" class="bg-yellow-500 text-white font-bold py-2 px-4 rounded-md hover:bg-yellow-600 mr-2">Ver Resumo de Pagamentos</a>
                            <button id="export-csv" class="bg-green-600 text-white font-bold py-2 px-4 rounded-md hover:bg-green-700">Exportar para Excel (CSV)</button>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8 text-center">
                        <div class="bg-red-100 p-4 rounded-lg"><p class="text-sm text-red-700">Total Arrecadado (Perdas)</p><p class="text-2xl font-bold text-red-800">R$ ${totalLostValue.toFixed(2)}</p></div>
                        <div class="bg-blue-100 p-4 rounded-lg"><p class="text-sm text-blue-700">Total a Pagar (Ganhos)</p><p class="text-2xl font-bold text-blue-800">R$ ${totalToPay.toFixed(2)}</p></div>
                        <div class="bg-green-100 p-4 rounded-lg"><p class="text-sm text-green-700">BalanÃ§o (Lucro)</p><p class="text-2xl font-bold text-green-800">R$ ${balance.toFixed(2)}</p></div>
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
                                    <th class="py-3 px-4 text-left">Utilizador</th>
                                    <th class="py-3 px-4 text-left">Chave PIX</th>
                                    <th class="py-3 px-4 text-left">Jogo</th>
                                    <th class="py-3 px-4 text-left">Palpite</th>
                                    <th class="py-3 px-4 text-left">Resultado do Jogo</th>
                                    <th class="py-3 px-4 text-left">Valor Aposta</th>
                                    <th class="py-3 px-4 text-left">Status</th>
                                    <th class="py-3 px-4 text-left">Valor a Pagar</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${reportData.length > 0 ? reportData.map(bet => `
                                    <tr class="border-b" data-game-title="${bet.gameTitle}">
                                        <td class="py-3 px-4">${bet.user.name}</td>
                                        <td class="py-3 px-4">${bet.user.pix}</td>
                                        <td class="py-3 px-4">${bet.gameTitle}</td>
                                        <td class="py-3 px-4">${bet.betChoice}</td>
                                        <td class="py-3 px-4">${bet.gameResult}</td>
                                        <td class="py-3 px-4">R$ ${bet.betValue.toFixed(2)}</td>
                                        <td class="py-3 px-4 font-semibold ${bet.betStatus === 'Ganhou' ? 'text-green-600' : 'text-red-600'}">${bet.betStatus}</td>
                                        <td class="py-3 px-4 font-bold text-blue-700">R$ ${bet.amountToPay.toFixed(2)}</td>
                                    </tr>
                                `).join('') : `
                                <tr>
                                    <td colspan="8" class="text-center py-10 text-gray-500">
                                        <p class="font-bold text-lg">Nenhum dado para exibir no relatÃ³rio.</p>
                                        <p>Isto pode acontecer porque ainda nÃ£o hÃ¡ jogos finalizados que tenham apostas confirmadas.</p>
                                    </td>
                                </tr>
                                `}
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
                        downloadCSV(csv.join('\\n'), 'relatorio_financeiro_detalhado.csv');
                    });
                </script>
            </body></html>
        `);

    } catch (error) {
        console.error("Erro ao gerar relatÃ³rio financeiro:", error);
        res.status(500).send("Erro ao gerar o relatÃ³rio financeiro.");
    }
});

// NOVA ROTA PARA O RESUMO DE PAGAMENTOS
app.get('/admin/payment-summary', authAdmin, async (req, res) => {
    try {
        const bets = await Bet.find({ status: 'approved' }).populate('gameId').lean();
        const finalizedGames = await Game.find({ status: 'finalizado' }).lean();

        const paymentsByUser = {};

        for (const game of finalizedGames) {
            const betsForGame = bets.filter(bet => bet.gameId && bet.gameId._id.equals(game._id));

            for (const bet of betsForGame) {
                let isWinner = false;
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
        }

        res.send(`
             <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Resumo de Pagamentos</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-4 md:p-8">
                <div class="container mx-auto bg-white p-6 rounded-lg shadow-md max-w-4xl">
                    <div class="flex justify-between items-center mb-6">
                        <h1 class="text-3xl font-bold text-gray-800">Resumo de Pagamentos</h1>
                        <a href="/admin/financial-report" class="bg-blue-500 text-white font-bold py-2 px-4 rounded-md hover:bg-blue-600">Voltar ao RelatÃ³rio Detalhado</a>
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
                                ${Object.keys(paymentsByUser).length > 0 ? Object.entries(paymentsByUser).map(([pix, data]) => `
                                    <tr class="border-b">
                                        <td class="py-3 px-4">${data.name}</td>
                                        <td class="py-3 px-4">${pix}</td>
                                        <td class="py-3 px-4 font-bold text-blue-700">R$ ${data.totalToPay.toFixed(2)}</td>
                                    </tr>
                                `).join('') : `
                                <tr><td colspan="3" class="text-center py-10 text-gray-500">Nenhum pagamento a ser feito no momento.</td></tr>
                                `}
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

// NOVA ROTA PARA LIMPAR HISTÃ“RICO
app.post('/admin/clear-history', authAdmin, async (req, res) => {
    try {
        // Deleta todas as apostas do banco de dados
        await Bet.deleteMany({});
        // Deleta todos os jogos que jÃ¡ foram marcados como 'finalizado'
        await Game.deleteMany({ status: 'finalizado' });
        
        res.redirect('/admin/dashboard');
    } catch (error) {
        console.error("Erro ao limpar o histÃ³rico:", error);
        res.status(500).send("Erro ao limpar o histÃ³rico de apostas.");
    }
});

app.post('/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin');
});

app.get('/admin/games', authAdmin, async (req, res) => {
    try {
        const games = await Game.find().sort({ status: 1, date: -1 }).lean();
        const openCount = games.filter(game => game.status === 'aberto').length;
        const closedCount = games.filter(game => game.status === 'fechado').length;
        const finalizedCount = games.filter(game => game.status === 'finalizado').length;
        const statusClass = { aberto: 'open', fechado: 'closed', finalizado: 'done' };
        const statusLabel = { aberto: 'Aberto', fechado: 'Fechado', finalizado: 'Finalizado' };

        const rows = games.map(game => `
            <tr>
                <td><b>${escapeHtml(game.home?.name)} vs ${escapeHtml(game.away?.name)}</b><div class="muted">${escapeHtml(game.competition)} · ${escapeHtml(game.date)}</div></td>
                <td><span class="pill ${statusClass[game.status] || ''}">${statusLabel[game.status] || game.status}</span></td>
                <td>Casa ${Number(game.odds?.home || 0).toFixed(2)}<br><span class="muted">X ${Number(game.odds?.draw || 0).toFixed(2)} · Fora ${Number(game.odds?.away || 0).toFixed(2)}</span></td>
                <td>R$ ${Number(game.maxBetValue || 0).toFixed(2)}</td>
                <td>${game.result === 'pendente' ? '<span class="muted">Pendente</span>' : escapeHtml(game.result)}</td>
                <td>
                    <div class="inline-actions">
                        ${game.status === 'aberto' ? `<a class="btn secondary" href="/admin/edit-game/${game._id}">Editar</a><form action="/admin/close-game/${game._id}" method="post"><button class="btn warn" type="submit">Fechar</button></form>` : ''}
                        ${game.status === 'fechado' ? `<form action="/admin/finalize-game/${game._id}" method="post" class="inline-actions"><select name="result"><option value="home">${escapeHtml(game.home?.name)}</option><option value="away">${escapeHtml(game.away?.name)}</option><option value="empate">Empate</option></select><button class="btn" type="submit">Finalizar</button></form>` : ''}
                        ${game.status === 'finalizado' ? '<span class="muted">Encerrado</span>' : ''}
                    </div>
                </td>
            </tr>`).join('');

        const content = `
            <div class="topline">
                <div><h1>Gerir jogos</h1><p class="muted">Crie jogos, ajuste odds e controle o ciclo da rodada.</p></div>
                <a class="btn secondary" href="/admin/dashboard">Voltar ao painel</a>
            </div>
            <section class="grid stats" style="margin-bottom:14px">
                <div class="card card-pad stat"><b>${openCount}</b><span>Abertos</span></div>
                <div class="card card-pad stat"><b>${closedCount}</b><span>Fechados</span></div>
                <div class="card card-pad stat"><b>${finalizedCount}</b><span>Finalizados</span></div>
                <div class="card card-pad stat"><b>${games.length}</b><span>Total</span></div>
            </section>
            <div class="split">
                <section class="card">
                    <div class="section-title"><h2>Jogos existentes</h2><span class="muted">Ações rápidas por status</span></div>
                    <div class="table-wrap">
                        <table>
                            <thead><tr><th>Jogo</th><th>Status</th><th>Odds</th><th>Limite</th><th>Resultado</th><th>Ações</th></tr></thead>
                            <tbody>${rows || '<tr><td colspan="6" class="muted">Nenhum jogo cadastrado.</td></tr>'}</tbody>
                        </table>
                    </div>
                </section>
                <aside class="card">
                    <div class="section-title"><h2>Novo jogo</h2><span class="muted">Cadastro rápido</span></div>
                    <form action="/admin/add-game" method="post" class="card-pad form-grid">
                        <div class="cols-2">
                            <div class="form-row"><label>Time casa</label><input name="home_name" placeholder="Ex: Medicina" required></div>
                            <div class="form-row"><label>Logo casa</label><input name="home_logo" placeholder="URL do escudo" required></div>
                        </div>
                        <div class="cols-2">
                            <div class="form-row"><label>Time visitante</label><input name="away_name" placeholder="Ex: Direito" required></div>
                            <div class="form-row"><label>Logo visitante</label><input name="away_logo" placeholder="URL do escudo" required></div>
                        </div>
                        <div class="cols-2">
                            <div class="form-row"><label>Data</label><input name="date" placeholder="25/12/2026 - 20:00" required></div>
                            <div class="form-row"><label>Competição</label><input name="competition" placeholder="Interclasse" required></div>
                        </div>
                        <div class="form-row"><label>Limite por usuário neste jogo</label><input type="number" step="0.01" name="max_bet_value" value="35" required></div>
                        <div class="cols-3">
                            <div class="form-row"><label>Odd casa</label><input type="number" step="0.01" name="odds_home" placeholder="1.50" required></div>
                            <div class="form-row"><label>Odd empate</label><input type="number" step="0.01" name="odds_draw" placeholder="3.00" required></div>
                            <div class="form-row"><label>Odd visitante</label><input type="number" step="0.01" name="odds_away" placeholder="2.20" required></div>
                        </div>
                        <button type="submit" class="btn">Adicionar jogo</button>
                    </form>
                </aside>
            </div>
        `;

        res.send(adminPage('Gerir jogos', content, 'games'));
    } catch (error) {
        console.error('Erro ao carregar jogos:', error);
        res.status(500).send('Erro ao carregar jogos.');
    }
});
app.post('/admin/add-game', authAdmin, async (req, res) => {
    try {
        const { home_name, home_logo, away_name, away_logo, date, competition, odds_home, odds_draw, odds_away, max_bet_value } = req.body;
        const oddsHome = toMoney(odds_home);
        const oddsDraw = toMoney(odds_draw);
        const oddsAway = toMoney(odds_away);
        const maxBetValue = toMoney(max_bet_value);
        if (!oddsHome || !oddsDraw || !oddsAway || !maxBetValue || maxBetValue <= 0) {
            return res.status(400).send("Odds e limite de aposta precisam ser valores vÃ¡lidos.");
        }
        const newGame = new Game({
            home: { name: cleanText(home_name), logo: cleanText(home_logo, 500) },
            away: { name: cleanText(away_name), logo: cleanText(away_logo, 500) },
            date: cleanText(date, 80),
            competition: cleanText(competition, 100),
            odds: { home: oddsHome, draw: oddsDraw, away: oddsAway },
            initialOdds: { home: oddsHome, draw: oddsDraw, away: oddsAway },
            maxBetValue
        });
        await newGame.save();
        res.redirect('/admin/games');
    } catch (error) { res.status(500).send("Erro ao adicionar jogo."); }
});

app.get('/admin/edit-game/:id', authAdmin, async(req, res) => {
    try {
        const game = await Game.findById(req.params.id).lean();
        if (!game) return res.status(404).send(adminPage('Jogo não encontrado', '<div class="topline"><div><h1>Jogo não encontrado</h1><p class="muted">Esse jogo não existe ou foi removido.</p></div><a class="btn secondary" href="/admin/games">Voltar</a></div>', 'games'));

        const content = `
            <div class="topline">
                <div><h1>Editar jogo</h1><p class="muted">${escapeHtml(game.home?.name)} vs ${escapeHtml(game.away?.name)}</p></div>
                <a class="btn secondary" href="/admin/games">Voltar aos jogos</a>
            </div>
            <section class="card" style="max-width:760px">
                <div class="section-title"><h2>Risco e odds</h2><span class="pill ${game.status === 'aberto' ? 'open' : game.status === 'fechado' ? 'closed' : 'done'}">${escapeHtml(game.status)}</span></div>
                <form action="/admin/edit-game/${game._id}" method="post" class="card-pad form-grid">
                    <div class="form-row"><label>Limite por usuário neste jogo</label><input type="number" step="0.01" name="max_bet_value" value="${Number(game.maxBetValue || 0)}" required></div>
                    <div class="cols-3">
                        <div class="form-row"><label>Odd casa</label><input type="number" step="0.01" name="odds_home" value="${Number(game.odds?.home || 0)}" required></div>
                        <div class="form-row"><label>Odd empate</label><input type="number" step="0.01" name="odds_draw" value="${Number(game.odds?.draw || 0)}" required></div>
                        <div class="form-row"><label>Odd visitante</label><input type="number" step="0.01" name="odds_away" value="${Number(game.odds?.away || 0)}" required></div>
                    </div>
                    <p class="muted" style="margin:0">Ao salvar, essas odds também viram a base do modelo de risco dinâmico.</p>
                    <div class="inline-actions"><button type="submit" class="btn">Salvar alterações</button><a href="/admin/games" class="btn secondary">Cancelar</a></div>
                </form>
            </section>
        `;

        res.send(adminPage('Editar jogo', content, 'games'));
    } catch (error) {
        console.error('Erro ao carregar jogo para edição:', error);
        res.status(500).send('Erro ao carregar jogo para edição.');
    }
});
app.post('/admin/edit-game/:id', authAdmin, async(req, res) => {
    try {
        const { odds_home, odds_draw, odds_away, max_bet_value } = req.body;
        const oddsHome = toMoney(odds_home);
        const oddsDraw = toMoney(odds_draw);
        const oddsAway = toMoney(odds_away);
        const maxBetValue = toMoney(max_bet_value);
        if (!oddsHome || !oddsDraw || !oddsAway || !maxBetValue || maxBetValue <= 0) {
            return res.status(400).send("Odds e limite de aposta precisam ser valores vÃ¡lidos.");
        }
        await Game.findByIdAndUpdate(req.params.id, {
            $set: {
                'odds.home': oddsHome,
                'odds.draw': oddsDraw,
                'odds.away': oddsAway,
                'initialOdds.home': oddsHome,
                'initialOdds.draw': oddsDraw,
                'initialOdds.away': oddsAway,
                'maxBetValue': maxBetValue
            }
        });
        res.redirect('/admin/games');
    } catch(error){ res.status(500).send("Erro ao salvar alteraÃ§Ãµes."); }
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
