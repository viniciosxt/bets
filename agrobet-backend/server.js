// 1. Importar os pacotes
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

// 2. Configurações iniciais
const app = express();
const port = process.env.PORT || 3000;
const DB_FILE = path.resolve(process.cwd(), 'relatorio_apostas.json');
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;

// 3. Middlewares
app.use(cors());
app.use(express.json());

// --- FUNÇÃO AUXILIAR PARA GUARDAR APOSTAS ---
async function saveBet(betData) {
    try {
        let allBets = [];
        try {
            const data = await fs.readFile(DB_FILE, 'utf-8');
            allBets = JSON.parse(data);
        } catch (error) {
            // Se o arquivo não existe, começa com um array vazio
        }
        allBets.unshift(betData);
        await fs.writeFile(DB_FILE, JSON.stringify(allBets, null, 2), 'utf-8');
    } catch (error) {
        console.error('Falha ao guardar a aposta no ficheiro.', error);
    }
}

// --- ROTAS DA APLICAÇÃO ---

// NOVA ROTA: Página inicial para mostrar que o servidor está online
app.get('/', (req, res) => {
    res.send('<h1>Servidor do AgroBet está no ar!</h1><p>Este é o back-end do site de apostas. A comunicação com ele é feita através do site principal.</p>');
});

// Rota principal para criar pagamentos
app.post('/criar-pagamento', async (req, res) => {
    try {
        if (!MERCADO_PAGO_ACCESS_TOKEN) {
            throw new Error("Token do Mercado Pago não foi configurado no servidor.");
        }
        const { title, description, unit_price, user } = req.body;
        if (!user || !user.name || !user.pix) {
            return res.status(400).send('Dados do utilizador (nome e PIX) são obrigatórios.');
        }
        const preference = {
            items: [{
                title,
                description,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: parseFloat(unit_price)
            }],
            back_urls: {
                success: 'https://viniciosxt.github.io/bets/', // Atualize se a URL do seu site mudar
                failure: 'https://viniciosxt.github.io/bets/',
            },
            auto_return: 'approved',
        };
        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
            },
            body: JSON.stringify(preference)
        });
        const data = await response.json();
        if (!response.ok) {
            console.error('Erro do Mercado Pago:', data);
            throw new Error('Falha na comunicação com o Mercado Pago.');
        }
        const betRecord = {
            gameTitle: title,
            betChoice: description.replace('Palpite: ', ''),
            betValue: unit_price,
            date: new Date().toLocaleString('pt-BR'),
            user: user
        };
        await saveBet(betRecord);
        res.json({ init_point: data.init_point });
    } catch (error) {
        console.error('Erro interno:', error.message);
        res.status(500).send('Erro ao criar a preferência de pagamento.');
    }
});

// ROTA DO ADMIN PARA VER O RELATÓRIO
app.get('/relatorio', async (req, res) => {
    try {
        let allBets = [];
        try {
            const data = await fs.readFile(DB_FILE, 'utf-8');
            allBets = JSON.parse(data);
        } catch (error) {
            // Arquivo não existe ou está vazio
        }
        let html = `
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório de Apostas - AgroBet</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-gray-100 p-8"><div class="max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-6">
            <h1 class="text-3xl font-bold text-green-700 mb-6">Relatório de Todas as Apostas</h1>
            ${allBets.length === 0 ? '<p>Nenhuma aposta registada ainda.</p>' : `
            <table class="min-w-full divide-y divide-gray-200"><thead class="bg-gray-50"><tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Apostador</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Chave PIX</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Aposta</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Valor</th>
            </tr></thead><tbody class="bg-white divide-y divide-gray-200">
            ${allBets.map(bet => `<tr>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${bet.date}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${bet.user.name}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${bet.user.pix}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${bet.betChoice} no jogo ${bet.gameTitle.replace('Aposta no jogo: ','')}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-green-600">R$ ${bet.betValue}</td>
            </tr>`).join('')}
            </tbody></table>`}</div></body></html>`;
        res.send(html);
    } catch (error) {
        console.error("Erro ao gerar relatório:", error);
        res.status(500).send("Erro ao gerar relatório.");
    }
});

// Inicia o servidor
app.listen(port, () => {
    console.log(`--> Servidor AgroBet a correr na porta ${port}`);
});

