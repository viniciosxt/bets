import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';

// --- Modelos da Base de Dados ---
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    pix: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true, minlength: 6 }
});
const User = mongoose.model('User', UserSchema);

const BetSchema = new mongoose.Schema({
    gameTitle: String,
    betChoice: String,
    betValue: Number,
    date: Date,
    user: {
        name: String,
        pix: String
    }
});
const Bet = mongoose.model('Bet', BetSchema);

// --- Conexão à Base de Dados ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Conexão com MongoDB estabelecida com sucesso."))
    .catch(err => console.error("Erro ao conectar com MongoDB:", err));

// --- Configuração do Servidor Express ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Configuração do Mercado Pago ---
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const preference = new Preference(client);

// --- ROTAS DA API ---

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>Servidor do AgroBet está no ar!</h1>
            <p>Este é o back-end do site de apostas. A comunicação com ele é feita através do site principal.</p>
        </body>
    `);
});

// Rota de Login de Utilizador
app.post('/login', async (req, res) => {
    try {
        const { pix, password } = req.body;
        if (!pix || !password) {
            return res.status(400).json({ success: false, message: "PIX e senha são obrigatórios." });
        }
        
        const user = await User.findOne({ pix: pix });
        if (!user) {
            return res.status(404).json({ success: false, message: "Utilizador não encontrado." });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Chave PIX ou senha inválida." });
        }

        // Não retornar a senha encriptada
        const userResponse = { _id: user._id, name: user.name, pix: user.pix };
        res.json({ success: true, user: userResponse });

    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ success: false, message: "Erro interno do servidor." });
    }
});

// Rota de Registo de Utilizador
app.post('/register', async (req, res) => {
    try {
        const { name, pix, password } = req.body;
        if (!name || !pix || !password) {
            return res.status(400).json({ success: false, message: "Nome, PIX e senha são obrigatórios." });
        }
        if (password.length < 6) {
             return res.status(400).json({ success: false, message: "A senha deve ter no mínimo 6 caracteres." });
        }

        const existingUser = await User.findOne({ pix: pix });
        if (existingUser) {
            return res.status(409).json({ success: false, message: "Esta chave PIX já está registada." });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ name, pix, password: hashedPassword });
        await newUser.save();

        // Não retornar a senha encriptada
        const userResponse = { _id: newUser._id, name: newUser.name, pix: newUser.pix };
        res.status(201).json({ success: true, user: userResponse });

    } catch (error) {
        console.error("Erro no registo:", error);
        res.status(500).json({ success: false, message: "Erro interno do servidor." });
    }
});

// Rota para criar pagamento (inalterada)
app.post('/criar-pagamento', async (req, res) => {
    const { title, description, unit_price, user } = req.body;
    try {
        const result = await preference.create({
            body: {
                items: [{
                    title: title,
                    description: description,
                    quantity: 1,
                    unit_price: Number(unit_price),
                    currency_id: 'BRL',
                }],
            }
        });
        const newBet = new Bet({
            gameTitle: title,
            betChoice: description.replace('Palpite: ', ''),
            betValue: Number(unit_price),
            date: new Date(),
            user: { name: user.name, pix: user.pix }
        });
        await newBet.save();
        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) {
        console.error('Erro ao criar pagamento ou guardar aposta:', error);
        res.status(500).send('Erro no servidor.');
    }
});

// Rota para obter o relatório de apostas (inalterada)
app.get('/relatorio', async (req, res) => {
    try {
        const bets = await Bet.find().sort({ date: -1 });
        let html = `
            <style>
                body { font-family: sans-serif; margin: 20px; background-color: #f4f4f4; } h1 { color: #2e7d32; } table { width: 100%; border-collapse: collapse; margin-top: 20px; } th, td { border: 1px solid #ddd; padding: 12px; text-align: left; } th { background-color: #2e7d32; color: white; } tr:nth-child(even) { background-color: #f2f2f2; } tr:hover { background-color: #ddd; }
            </style>
            <h1>Relatório de Apostas - AgroBet</h1>
            <table>
                <thead> <tr> <th>Data</th> <th>Jogo</th> <th>Palpite</th> <th>Valor (R$)</th> <th>Apostador</th> <th>Chave PIX</th> </tr> </thead>
                <tbody>
        `;
        bets.forEach(bet => {
            html += `
                <tr>
                    <td>${new Date(bet.date).toLocaleString('pt-BR')}</td>
                    <td>${bet.gameTitle.replace('Aposta no jogo: ', '')}</td>
                    <td>${bet.betChoice}</td>
                    <td>${bet.betValue.toFixed(2)}</td>
                    <td>${bet.user.name}</td>
                    <td>${bet.user.pix}</td>
                </tr>
            `;
        });
        html += '</tbody></table>';
        res.send(html);
    } catch (error) {
        console.error("Erro ao gerar relatório:", error);
        res.status(500).send("Erro ao gerar relatório.");
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`--> Servidor AgroBet a correr na porta ${PORT}`);
});

