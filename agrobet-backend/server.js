import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

// --- NOVOS MODELOS DA BASE DE DADOS ---
const UserSchema = new mongoose.Schema({ name: { type: String, required: true }, pix: { type: String, required: true, unique: true, index: true }, password: { type: String, required: true, minlength: 6 } });
const User = mongoose.model('User', UserSchema);

const GameSchema = new mongoose.Schema({
    home: { name: String, logo: String },
    away: { name: String, logo: String },
    date: String,
    competition: String,
    status: { type: String, enum: ['aberto', 'fechado', 'finalizado'], default: 'aberto' },
    // Resultados do Vencedor
    result: { type: String, enum: ['home', 'away', 'empate', 'pendente'], default: 'pendente' },
    // Novos campos para as novas modalidades
    players: [String],
    finalScore: { home: Number, away: Number },
    bestPlayerResult: String
});
const Game = mongoose.model('Game', GameSchema);

const BetSchema = new mongoose.Schema({
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
    gameTitle: String,
    betType: { type: String, enum: ['vitoria', 'placar', 'melhor_jogador'], required: true },
    betChoice: String, // ex: 'home', '2x1', 'Nome do Jogador'
    betValue: Number,
    date: Date,
    user: { name: String, pix: String },
    status: { type: String, default: 'pending' }
});
const Bet = mongoose.model('Bet', BetSchema);


// --- Conexão e Configuração (sem alterações) ---
mongoose.connect(process.env.MONGODB_URI).then(() => console.log("Conexão com MongoDB estabelecida.")).catch(err => console.error("Erro ao conectar com MongoDB:", err));
const app = express();
app.use(cors()); app.use(bodyParser.json()); app.use(bodyParser.urlencoded({ extended: true })); app.use(cookieParser());
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const preference = new Preference(client); const payment = new Payment(client);
const authAdmin = (req, res, next) => { const token = req.cookies.admin_token; if (!token) return res.redirect('/admin'); try { jwt.verify(token, process.env.JWT_SECRET); next(); } catch (e) { return res.redirect('/admin'); } };

// --- ROTAS PÚBLICAS ---
app.get('/', (req, res) => res.send('<h1>Servidor do AgroBet está no ar!</h1>'));
app.post('/login', async (req, res) => { try { const { pix, password } = req.body; const user = await User.findOne({ pix }); if (!user) return res.status(404).json({ success: false, message: 'Utilizador não encontrado.' }); const isMatch = await bcrypt.compare(password, user.password); if (!isMatch) return res.status(400).json({ success: false, message: 'Senha incorreta.' }); res.json({ success: true, user: { name: user.name, pix: user.pix } }); } catch (error) { res.status(500).json({ success: false, message: 'Erro no servidor.' }); } });
app.post('/register', async (req, res) => { try { const { name, pix, password } = req.body; let user = await User.findOne({ pix }); if (user) return res.status(400).json({ success: false, message: 'Esta chave PIX já está registada.' }); const salt = await bcrypt.genSalt(10); const hashedPassword = await bcrypt.hash(password, salt); user = new User({ name, pix, password: hashedPassword }); await user.save(); res.json({ success: true, user: { name: user.name, pix: user.pix } }); } catch (error) { res.status(500).json({ success: false, message: 'Erro no servidor.' }); } });
app.get('/games', async (req, res) => { try { const openGames = await Game.find({ status: 'aberto' }).sort({ date: 1 }); res.json(openGames); } catch (error) { res.status(500).json({ message: "Erro ao buscar jogos." }); } });
app.post('/criar-pagamento', async (req, res) => { const { gameId, betType, betChoice, unit_price, user } = req.body; try { const game = await Game.findById(gameId); if (!game || game.status !== 'aberto') { return res.status(400).json({ message: 'Este jogo não está mais aberto para apostas.' }); } const description = `Tipo: ${betType} | Palpite: ${betChoice}`; const preferenceData = { body: { items: [{ id: gameId, title: `${game.home.name} vs ${game.away.name}`, description, quantity: 1, unit_price: Number(unit_price), currency_id: 'BRL' }], back_urls: { success: process.env.FRONTEND_URL, failure: process.env.FRONTEND_URL, pending: process.env.FRONTEND_URL }, notification_url: `${process.env.SERVER_URL}/webhook-mercadopago`, metadata: { game_id: gameId, user_pix: user.pix, bet_type: betType, bet_choice: betChoice, bet_value: unit_price, user_name: user.name } } }; const result = await preference.create(preferenceData); res.json({ id: result.id, init_point: result.init_point }); } catch (error) { console.error("ERRO AO CRIAR PAGAMENTO:", error); res.status(500).json({ message: 'Erro no servidor ao criar pagamento.' }); } });
app.post('/webhook-mercadopago', async (req, res) => { try { if (req.body.type === 'payment') { const paymentDetails = await payment.get({ id: req.body.data.id }); if (paymentDetails.status === 'approved') { const metadata = paymentDetails.metadata; const game = await Game.findById(metadata.game_id); const newBet = new Bet({ gameId: metadata.game_id, gameTitle: game ? `${game.home.name} vs ${game.away.name}` : 'Jogo Desconhecido', betType: metadata.bet_type, betChoice: metadata.bet_choice, betValue: Number(metadata.bet_value), date: new Date(), user: { name: metadata.user_name, pix: metadata.user_pix }, status: 'approved' }); await newBet.save(); } } res.sendStatus(200); } catch (error) { console.error("Erro no webhook:", error); res.sendStatus(500); } });
app.get('/my-bets/:pix', async (req, res) => { try { const bets = await Bet.find({ 'user.pix': req.params.pix, status: 'approved' }).sort({ date: -1 }); res.json({ success: true, bets }); } catch (error) { res.json({ success: false, message: 'Erro ao buscar apostas.' }); } });
app.get('/relatorio', async (req, res) => { try { const bets = await Bet.find({ status: 'approved' }).sort({ date: -1 }); let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório de Apostas</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 p-8"><div class="container mx-auto bg-white p-6 rounded-lg shadow-md"><h1 class="text-3xl font-bold mb-6 text-gray-800">Relatório de Apostas Confirmadas</h1><div class="overflow-x-auto"><table class="min-w-full bg-white"><thead class="bg-gray-800 text-white"><tr><th class="py-3 px-4 text-left">Data</th><th class="py-3 px-4 text-left">Utilizador</th><th class="py-3 px-4 text-left">Jogo</th><th class="py-3 px-4 text-left">Tipo de Aposta</th><th class="py-3 px-4 text-left">Palpite</th><th class="py-3 px-4 text-left">Valor</th></tr></thead><tbody>`; bets.forEach(bet => { html += `<tr class="border-b"><td class="py-3 px-4">${new Date(bet.date).toLocaleString('pt-BR')}</td><td class="py-3 px-4">${bet.user.name}</td><td class="py-3 px-4">${bet.gameTitle}</td><td class="py-3 px-4">${bet.betType}</td><td class="py-3 px-4">${bet.betChoice}</td><td class="py-3 px-4 font-semibold text-green-700">R$ ${bet.betValue.toFixed(2)}</td></tr>`; }); html += `</tbody></table></div></div></body></html>`; res.send(html); } catch (error) { console.error("Erro ao gerar relatório:", error); res.status(500).send("Erro ao gerar o relatório."); } });
app.get('/results', async (req, res) => { try { const finishedGames = await Game.find({ status: 'finalizado' }).sort({ date: -1 }); res.json(finishedGames); } catch (error) { res.status(500).json({ message: "Erro ao buscar resultados." }); } });

// --- PAINEL DE ADMINISTRAÇÃO ATUALIZADO ---
app.get('/admin', (req, res) => { res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Admin Login</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-200 min-h-screen flex items-center justify-center"><div class="bg-white p-8 rounded-lg shadow-lg w-full max-w-sm"><h1 class="text-2xl font-bold text-center mb-6">Login de Administrador</h1><form action="/admin/login" method="post"><label for="password" class="block text-sm font-medium text-gray-700">Senha de Admin</label><input type="password" name="password" id="password" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"><button type="submit" class="w-full mt-6 bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-md">Entrar</button></form></div></body></html>`); });
app.post('/admin/login', (req, res) => { const { password } = req.body; if (password === process.env.ADMIN_PASSWORD) { const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '8h' }); res.cookie('admin_token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 28800000 }); res.redirect('/admin/games'); } else { res.send('<h1>Senha incorreta.</h1><a href="/admin">Tentar novamente</a>'); } });
app.post('/admin/logout', (req, res) => { res.clearCookie('admin_token'); res.redirect('/admin'); });

app.get('/admin/games', authAdmin, async (req, res) => {
    try {
        const games = await Game.find().sort({ date: -1 });
        let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Gerir Jogos</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 p-8"><div class="container mx-auto">
            <div class="flex justify-between items-center mb-6"><h1 class="text-3xl font-bold text-gray-800">Painel de Gestão de Jogos</h1><div class="flex items-center space-x-4"><a href="/relatorio" target="_blank" class="text-blue-600 hover:underline">Ver Relatório</a><form action="/admin/logout" method="post"><button type="submit" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-md">Sair</button></form></div></div>
            <div class="bg-white p-6 rounded-lg shadow-md mb-8"><h2 class="text-2xl font-bold mb-4">Adicionar Novo Jogo</h2><form action="/admin/add-game" method="post" class="space-y-4">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4"><input required class="px-3 py-2 border rounded" type="text" name="homeName" placeholder="Nome Time da Casa"><input required class="px-3 py-2 border rounded" type="text" name="awayName" placeholder="Nome Time Visitante"><input required class="px-3 py-2 border rounded" type="text" name="homeLogo" placeholder="URL Logo Casa"><input required class="px-3 py-2 border rounded" type="text" name="awayLogo" placeholder="URL Logo Visitante"><input required class="px-3 py-2 border rounded" type="text" name="date" placeholder="Data e Hora (ex: 25/12/2025 - 20:00)"><input required class="px-3 py-2 border rounded" type="text" name="competition" placeholder="Nome da Competição"></div>
                <div><label class="block text-sm font-medium">Jogadores (um por linha)</label><textarea name="players" class="mt-1 block w-full px-3 py-2 border rounded" rows="4" placeholder="Jogador A\nJogador B\nJogador C"></textarea></div>
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-md">Adicionar Jogo</button></form></div>
            <div class="bg-white p-6 rounded-lg shadow-md"><h2 class="text-2xl font-bold mb-4">Jogos Criados</h2><div class="space-y-4">`;

        games.forEach(game => {
            let statusColor = game.status === 'aberto' ? 'bg-green-100 text-green-800' : (game.status === 'fechado' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-200 text-gray-800');
            html += `<div class="border rounded-lg p-4"><div class="flex justify-between items-center"><div class="flex-1"><p class="font-bold text-lg">${game.home.name} vs ${game.away.name}</p><p class="text-sm text-gray-600">${game.competition} - ${game.date}</p><p class="mt-1 text-xs font-semibold px-2 py-1 rounded-full inline-block ${statusColor}">${game.status.toUpperCase()}</p></div><div class="flex items-center space-x-2">`;
            if (game.status === 'aberto') {
                html += `<form action="/admin/close-game/${game._id}" method="post"><button class="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-1 px-3 rounded">Fechar Apostas</button></form>`;
            }
            if (game.status === 'fechado') {
                html += `<form action="/admin/finalize-game/${game._id}" method="post" class="bg-gray-50 p-4 rounded-lg space-y-3"><p class="font-bold">Definir Resultados:</p>
                    <div class="grid grid-cols-3 gap-2">
                        <label>Vencedor:</label>
                        <select name="result" class="col-span-2 border rounded px-2 py-1"><option value="home">${game.home.name}</option><option value="away">${game.away.name}</option><option value="empate">Empate</option></select>
                        <label>Placar Casa:</label>
                        <input type="number" name="finalScoreHome" class="col-span-2 border rounded px-2 py-1" placeholder="0">
                        <label>Placar Visitante:</label>
                        <input type="number" name="finalScoreAway" class="col-span-2 border rounded px-2 py-1" placeholder="0">
                        <label>Melhor Jogador:</label>
                        <select name="bestPlayerResult" class="col-span-2 border rounded px-2 py-1"><option value="">N/A</option>${game.players.map(p => `<option value="${p}">${p}</option>`).join('')}</select>
                    </div>
                    <button class="w-full bg-gray-700 hover:bg-gray-800 text-white font-bold py-2 px-3 rounded">Finalizar Jogo</button></form>`;
            }
            if (game.status === 'finalizado') {
                html += `<div class="text-right"><p><strong>Vencedor:</strong> ${game.result}</p><p><strong>Placar:</strong> ${game.finalScore.home} x ${game.finalScore.away}</p><p><strong>Melhor Jogador:</strong> ${game.bestPlayerResult || 'N/A'}</p></div>`;
            }
            html += `</div></div></div>`;
        });
        html += `</div></div></div></body></html>`;
        res.send(html);
    } catch (error) { res.status(500).send("Erro ao carregar a página de gestão de jogos."); }
});

app.post('/admin/add-game', authAdmin, async (req, res) => { try { const { homeName, awayName, homeLogo, awayLogo, date, competition, players } = req.body; const playersArray = players.split(/\r?\n/).filter(p => p.trim() !== ''); const newGame = new Game({ home: { name: homeName, logo: homeLogo }, away: { name: awayName, logo: awayLogo }, date, competition, players: playersArray }); await newGame.save(); res.redirect('/admin/games'); } catch (error) { res.status(500).send("Erro ao adicionar jogo."); } });
app.post('/admin/close-game/:id', authAdmin, async (req, res) => { try { await Game.findByIdAndUpdate(req.params.id, { status: 'fechado' }); res.redirect('/admin/games'); } catch (error) { res.status(500).send("Erro ao fechar jogo."); } });
app.post('/admin/finalize-game/:id', authAdmin, async (req, res) => { try { const { result, finalScoreHome, finalScoreAway, bestPlayerResult } = req.body; await Game.findByIdAndUpdate(req.params.id, { status: 'finalizado', result, finalScore: { home: finalScoreHome, away: finalScoreAway }, bestPlayerResult }); res.redirect('/admin/games'); } catch (error) { res.status(500).send("Erro ao finalizar jogo."); } });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`--> Servidor AgroBet a correr na porta ${PORT}`));

