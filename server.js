require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const mysql = require('mysql2');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed:', err);
        return;
    }
    console.log('Connected to Azure Database for MySQL (using Pool)');
    connection.release();
});

const blobServiceClient = BlobServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING
);
const containerClient = blobServiceClient.getContainerClient(
    process.env.AZURE_STORAGE_CONTAINER
);

// Multer setup with Azure Storage
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['.pdf', '.docx', '.zip', '.rar', '.ppt', '.pptx'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed'), false);
        }
    }
});

// App setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-key',
    resave: false,
    saveUninitialized: true
}));

// ============ ROUTES ============

// Home
app.get('/', (req, res) => {
    res.render('index', { title: 'PraktikumSubmit - Home' });
});

// Submit Task Page
app.get('/submit-task', (req, res) => {
    res.render('submit-task', { title: 'Submit Tugas', error: null, success: null });
});

// Submit Task POST
app.post('/submit-task', upload.single('file'), async (req, res) => {
    const { nim, name, class: className, course } = req.body;
    const file = req.file;

    if (!file) {
        return res.render('submit-task', {
            title: 'Submit Tugas',
            error: 'File harus diunggah',
            success: null
        });
    }

    try {
        // Generate unique filename
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const blobName = `${timestamp}_${nim}_${name}_tugas${ext}`;

        // Upload to Azure Blob Storage
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(file.buffer, {
            blobHTTPHeaders: { blobContentType: file.mimetype }
        });

        // Get file URL
        const fileUrl = blockBlobClient.url;

        // Save to database
        const sql = `INSERT INTO submissions 
                     (nim, name, class, course, filename, file_url, status) 
                     VALUES (?, ?, ?, ?, ?, ?, 'Submitted')`;

        await db.promise().query(sql, [nim, name, className, course, file.originalname, fileUrl]);

        res.render('submit-task', {
            title: 'Submit Tugas',
            error: null,
            success: 'Tugas berhasil dikumpulkan!'
        });

    } catch (error) {
        console.error('Error:', error);
        res.render('submit-task', {
            title: 'Submit Tugas',
            error: 'Gagal mengumpulkan tugas: ' + error.message,
            success: null
        });
    }
});

// Task List
app.get('/task-list', async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            'SELECT * FROM submissions ORDER BY upload_time DESC'
        );
        res.render('task-list', {
            title: 'Daftar Tugas',
            submissions: rows,
            isAdmin: req.session.isAdmin || false
        });
    } catch (error) {
        console.error('Error:', error);
        res.render('task-list', {
            title: 'Daftar Tugas',
            submissions: [],
            isAdmin: false
        });
    }
});

// Task Detail
app.get('/task-detail/:id', async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            'SELECT * FROM submissions WHERE id = ?',
            [req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).send('Tugas tidak ditemukan');
        }

        res.render('task-detail', {
            title: 'Detail Tugas',
            submission: rows[0]
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Error mengambil data');
    }
});

// Admin Login
app.get('/admin-login', (req, res) => {
    res.render('admin-login', {
        title: 'Admin Login',
        error: null
    });
});

app.post('/admin-login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const [rows] = await db.promise().query(
            'SELECT * FROM users WHERE username = ? AND password = ?',
            [username, password]
        );

        if (rows.length > 0) {
            req.session.isAdmin = true;
            req.session.username = username;
            res.redirect('/task-list');
        } else {
            res.render('admin-login', {
                title: 'Admin Login',
                error: 'Username atau password salah'
            });
        }
    } catch (error) {
        console.error('Error:', error);
        res.render('admin-login', {
            title: 'Admin Login',
            error: 'Error login'
        });
    }
});

// Admin Logout
app.get('/admin-logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});