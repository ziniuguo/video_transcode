const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const {
    v4: uuidv4
} = require('uuid');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const DB_FILE = './users.db';

if (!fs.existsSync(DB_FILE)) {
    console.log('Database file not found, creating new database...');
    fs.writeFileSync(DB_FILE, '');
}

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error('Could not connect to database', err);
    } else {
        console.log('Connected to SQLite database');
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            uuid TEXT UNIQUE
            )
        `);
    }
});

const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';

app.use(bodyParser.urlencoded({
    extended: false
}));

// app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// TODO: 把login写了，一个user对应一个uuid
app.post('/login', (req, res) => {
    const {
        username,
        password
    } = req.body;
    // console.log(username);
    // console.log(password);

    db.get(
        'SELECT * FROM users WHERE username = ? AND password = ?',
        [username, password],
        (err, row) => {
            if (err) {
                console.error('Database error:', err);
                res.status(500).send('Internal server error');
            } else if (row) {
                res.send({
                    message: `Login successful!`,
                    userId: row.uuid
                });
            } else {
                res.status(401).send('Login failed. Invalid username or password.');
            }
        }
    );
});

app.post('/register', (req, res) => {
    const {
        username,
        password
    } = req.body;
    const userId = uuidv4();

    db.run(
        'INSERT INTO users (username, password, uuid) VALUES (?, ?, ?)',
        [username, password, userId],
        function (err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    res.status(400).send({
                        success: false,
                        message: 'Username already exists'
                    });
                } else {
                    console.error('Database error:', err);
                    res.status(500).send({
                        success: false,
                        message: 'Internal server error'
                    });
                }
            } else {
                res.send({
                    success: true,
                    message: 'Registration successful',
                    userId: userId
                });
            }
        }
    );
});

// TODO: upload的时候对应一个文件夹（名字是uuid），文件夹里两个文件夹，一个upload一个transcode，是所有video
app.post('/upload/:userId', (req, res) => {
    const userId = req.params.userId;

    const userDir = path.join(__dirname, 'uploads', userId);
    const uploadDir = path.join(userDir, 'upload');
    const transcodeDir = path.join(userDir, 'transcode');

    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, {
            recursive: true
        });
        fs.mkdirSync(uploadDir, {
            recursive: true
        });
        fs.mkdirSync(transcodeDir, {
            recursive: true
        });
    }

    const storage = multer.diskStorage({
        destination: uploadDir,
        filename: function (req, file, cb) {
            cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
        }
    });

    const upload = multer({
        storage: storage,
        limits: {
            fileSize: 100000000
        },
        fileFilter: function (req, file, cb) {
            checkFileType(file, cb);
        }
    }).single('video');

    upload(req, res, async (err) => {
        if (err) {
            res.status(400).send({
                msg: err
            });
        } else {
            if (req.file === undefined) {
                res.status(400).send({
                    msg: 'No file selected!'
                });
            } else {
                const filePath = path.join(uploadDir, req.file.filename);
                const outputFilePath = path.join(transcodeDir, `transcoded-${req.file.filename}`);

                try {
                    await transcodeVideo(filePath, outputFilePath, '1280x720');
                    res.status(200).send({
                        msg: 'File uploaded and transcoded!',
                        file: `uploads/${userId}/transcode/transcoded-${req.file.filename}`
                    });
                } catch (error) {
                    res.status(500).send({
                        msg: 'Error during transcoding'
                    });
                }
            }
        }
    });
});

function checkFileType(file, cb) {
    const filetypes = /mp4|mov|avi|mkv/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb('Error: Videos Only!');
    }
}

function transcodeVideo(inputPath, outputPath, resolution) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .size(resolution)
            .on('end', () => {
                console.log(`File has been transcoded to ${resolution}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error transcoding file: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

app.listen(PORT, HOST, () => console.log(`Server started on port ${PORT}`));
// 别骂了我知道我什么都没写比如md5加盐加密和效率，但是我这不是在乱写并且模仿初级者水平吗？
// 别骂了我知道我什么都没写比如md5加盐加密和效率，但是我这不是在乱写并且模仿初级者水平吗？
// 别骂了我知道我什么都没写比如md5加盐加密和效率，但是我这不是在乱写并且模仿初级者水平吗？