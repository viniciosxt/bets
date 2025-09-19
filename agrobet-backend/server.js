// 1. Importar os pacotes
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs/promises'; // Módulo para lidar com arquivos
import path from 'path'; // Módulo para lidar com caminhos de arquivos

// NOVO: Um "salva-vidas" para apanhar erros inesperados que podem desligar o servidor
process.on('uncaughtException', (err, origin) => {
  console.error('--- ERRO INESPERADO QUE DESLIGOU O SERVIDOR ---');
  console.error(err);
  console.error('Origem do erro:', origin);
  process.exit(1);
});

// 2. Configurações iniciais
const app = express();
const port = 3000;
// Garante que o caminho para o arquivo de relatório está correto
const DB_FILE = path.resolve(process.cwd(), 'relatorio_apostas.json');

// --- SEU ACCESS TOKEN SEGURO NO BACK-END ---
const MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-1589862643117318-091813-46df519896a260659149ac570ccd317d-2446532541';

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
            console.log('LOG: Arquivo de relatório não encontrado, a criar um novo.');
        }

        allBets.unshift(betData);
        await fs.writeFile(DB_FILE, JSON.stringify(allBets, null, 2), 'utf-8');
        console.log('LOG: Aposta guardada com sucesso no relatório.');
    } catch (error) {
        console.error('LOG DE ERRO: Falha ao guardar a aposta no ficheiro.', error);
    }
}

// 4. Rota principal para criar pagamentos
app.post('/criar-pagamento', async (req, res) => {
    console.log('\n--- ROTA /criar-pagamento ACESSADA ---');
    try {
        const { title, description, unit_price, user } = req.body;
        console.log('LOG: Dados recebidos do front-end:', req.body);

        if (!user || !user.name || !user.pix) {
            console.error('LOG DE ERRO: Dados do utilizador incompletos.');
            return res.status(400).send('Dados do utilizador (nome e PIX) são obrigatórios.');
        }

        const preference = {
            items: [{
                title: title,
                description: description,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: parseFloat(unit_price)
            }],
            back_urls: {
                success: 'https://viniciosxt.github.io/agrobet/',
                failure: 'https://viniciosxt.github.io/agrobet/',
            },
            auto_return: 'approved',
        };
        console.log('LOG: A preparar para enviar preferência para o Mercado Pago...');

        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
            },
            body: JSON.stringify(preference)
        });
        console.log(`LOG: Resposta do Mercado Pago recebida. Status: ${response.status}`);

        const data = await response.json();

        if (!response.ok) {
            console.error('LOG DE ERRO do Mercado Pago:', data);
            throw new Error(`Falha na comunicação com o Mercado Pago. Status: ${response.status}`);
        }
        console.log('LOG: Preferência de pagamento criada com sucesso.');

        const betRecord = {
            gameTitle: title,
            betChoice: description.replace('Palpite: ', ''),
            betValue: unit_price,
            date: new Date().toLocaleString('pt-BR'),
            user: user
        };
        console.log('LOG: A preparar para guardar registo da aposta:', betRecord);

        await saveBet(betRecord);

        console.log('LOG: A enviar URL de pagamento de volta para o front-end.');
        res.json({ init_point: data.init_point });
        console.log('--- ROTA /criar-pagamento CONCLUÍDA COM SUCESSO ---');

    } catch (error) {
        console.error('--- ERRO DENTRO DO BLOCO CATCH DA ROTA /criar-pagamento ---');
        console.error(error);
        res.status(500).send('Erro ao criar a preferência de pagamento.');
    }
});

// 5. ROTA DO ADMIN PARA VER O RELATÓRIO
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
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <title>Relatório de Apostas - AgroBet</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <style> body { font-family: sans-serif; } </style>
            </head>
            <body class="bg-gray-100 p-8">
                <div class="max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-6">
                    <h1 class="text-3xl font-bold text-green-700 mb-6">Relatório de Todas as Apostas</h1>
                    ${allBets.length === 0 ? '<p>Nenhuma aposta registada ainda.</p>' : `
                    <table class="min-w-full divide-y divide-gray-200">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Apostador</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Chave PIX</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Aposta</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Valor</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-gray-200">
                            ${allBets.map(bet => `
                                <tr>
                                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${bet.date}</td>
                                    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${bet.user.name}</td>
                                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${bet.user.pix}</td>
                                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${bet.betChoice} no jogo ${bet.gameTitle.replace('Aposta no jogo: ','')}</td>
                                    <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-green-600">R$ ${bet.betValue}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    `}
                </div>
            </body>
            </html>
        `;
        res.send(html);
    } catch (error) {
        console.error("Erro ao gerar relatório:", error);
        res.status(500).send("Erro ao gerar relatório.");
    }
});

// 6. Inicia o servidor
app.listen(port, () => {
    console.log(`--> SERVIDOR NO AR! <--`);
    console.log(`--> Servidor AgroBet a correr em http://localhost:${port}`);
    console.log('--> Aceda ao relatório em: http://localhost:3000/relatorio');
    console.log('A aguardar requisições do site...');
});

