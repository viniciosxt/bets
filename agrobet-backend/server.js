import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
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
// Usamos express.json() para a maioria das rotas, mas o webhook precisa do body "raw"
app.use((req, res, next) => {
    if (req.originalUrl === '/webhook-mercadopago') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

// --- Configuração do Mercado Pago ---
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const preference = new Preference(client);
const payment = new Payment(client);

// --- ROTAS DA API ---

app.get('/', (req, res) => {
    res.send(`<body style="font-family: sans-serif; text-align: center; padding-top: 50px;"><h1>Servidor do AgroBet está no ar!</h1><p>Este é o back-end do site de apostas.</p></body>`);
});

// Rotas de Login e Registo (inalteradas)
app.post('/login', async (req, res) => {
    try {
        const { pix, password } = req.body;
        const user = await User.findOne({ pix });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ success: false, message: "Chave PIX ou senha inválida." });
        }
        res.json({ success: true, user: { name: user.name, pix: user.pix } });
    } catch (error) { res.status(500).json({ success: false, message: "Erro interno do servidor." }); }
});

app.post('/register', async (req, res) => {
    try {
        const { name, pix, password } = req.body;
        if (password.length < 6) return res.status(400).json({ success: false, message: "A senha deve ter no mínimo 6 caracteres." });
        if (await User.findOne({ pix })) return res.status(409).json({ success: false, message: "Esta chave PIX já está registada." });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ name, pix, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ success: true, user: { name: newUser.name, pix: newUser.pix } });
    } catch (error) { res.status(500).json({ success: false, message: "Erro interno do servidor." }); }
});

// Rota para CRIAR a preferência de pagamento
app.post('/criar-pagamento', async (req, res) => {
    const { title, description, unit_price, user } = req.body;
    try {
        const result = await preference.create({
            body: {
                items: [{
                    title,
                    description,
                    quantity: 1,
                    unit_price: Number(unit_price),
                    currency_id: 'BRL',
                }],
                // A URL para onde o Mercado Pago enviará a notificação de pagamento
                notification_url: "https://agrobets.onrender.com/webhook-mercadopago",
                // Metadados que vamos usar para guardar a aposta quando o pagamento for confirmado
                metadata: {
                    gameTitle: title,
                    betChoice: description.replace('Palpite: ', ''),
                    betValue: Number(unit_price),
                    user
                }
            }
        });
        // A aposta NÃO é guardada aqui. Apenas enviamos o link de pagamento.
        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) {
        console.error('Erro ao criar preferência de pagamento:', error);
        res.status(500).send('Erro no servidor ao criar pagamento.');
    }
});

// Rota de WEBHOOK para receber a confirmação do Mercado Pago
app.post('/webhook-mercadopago', express.raw({ type: 'application/json' }), async (req, res) => {
    const notification = req.body;
    try {
        if (notification.type === 'payment') {
            const paymentId = notification.data.id;
            console.log("Recebido webhook para o pagamento ID:", paymentId);

            const paymentDetails = await payment.get({ id: paymentId });

            if (paymentDetails && paymentDetails.status === 'approved') {
                console.log("Pagamento APROVADO. A guardar aposta na base de dados...");
                const metadata = paymentDetails.metadata;

                const newBet = new Bet({
                    gameTitle: metadata.game_title,
                    betChoice: metadata.bet_choice,
                    betValue: metadata.bet_value,
                    date: new Date(),
                    user: {
                        name: metadata.user.name,
                        pix: metadata.user.pix
                    }
                });
                await newBet.save();
                console.log("Aposta guardada com sucesso!");
            } else {
                 console.log("Status do pagamento não é 'approved':", paymentDetails.status);
            }
        }
        res.status(200).send('Webhook recebido');
    } catch (error) {
        console.error('Erro no processamento do webhook:', error);
        res.status(500).send('Erro no servidor ao processar webhook.');
    }
});


// Rota para o relatório (agora só mostra apostas confirmadas)
app.get('/relatorio', async (req, res) => {
    try {
        const bets = await Bet.find().sort({ date: -1 });
        let html = `
            <style>
                body { font-family: sans-serif; margin: 20px; background-color: #f4f4f4; } h1 { color: #2e7d32; } table { width: 100%; border-collapse: collapse; margin-top: 20px; } th, td { border: 1px solid #ddd; padding: 12px; text-align: left; } th { background-color: #2e7d32; color: white; } tr:nth-child(even) { background-color: #f2f2f2; } tr:hover { background-color: #ddd; }
            </style>
            <h1>Relatório de Apostas Confirmadas - AgroBet</h1>
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
    } catch (error) { res.status(500).send("Erro ao gerar relatório."); }
});


// Rota para buscar as apostas de um utilizador
app.get('/my-bets/:pix', async (req, res) => {
    try {
        const userPix = req.params.pix;
        const userBets = await Bet.find({ 'user.pix': userPix }).sort({ date: -1 });
        res.json({ success: true, bets: userBets });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao buscar apostas.' });
    }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`--> Servidor AgroBet a correr na porta ${PORT}`);
});

