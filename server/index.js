import express from 'express';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile('index.html', { root: 'public' });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});