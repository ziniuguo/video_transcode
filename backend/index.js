const { randomUUID } = require('crypto');
const fs = require('fs');
const express = require("express");
const multer = require("multer");
const path = require("path");
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT)");
});

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.get('/', (req, res) => res.send("welcome hello warudo"));

// TODO: 把login写了，一个user对应一个uuid
// TODO: upload的时候对应一个文件夹（名字是uuid），文件夹里两个文件夹，一个upload一个transcode，是所有video
// TODO: video名字一个原名字一个加transcoded
app.post('/register', (req, res) => {
    const {username, password} = req.body;

    // 插入新用户到数据库中
    const stmt = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)");

    stmt.run(username, password, function (err) {
        if (err) {
            if (err.code === 'SQLITE_CONSTRAINT') {
                // 用户名已存在
                res.status(409).json({message: 'Username already exists'});
            } else {
                res.status(500).json({message: 'Database error'});
            }
        } else {
            res.status(201).json({message: 'User registered successfully'});
        }
    });

    stmt.finalize();
});

app.post('/login', (req, res) => {
    const {username, password} = req.body;

    // 在数据库中查找用户名和密码
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err) {
            res.status(500).json({message: 'Database error'});
        } else if (row) {
            res.json({message: 'Login successful'});
        } else {
            res.status(401).json({message: 'Login failed'});
        }
    });
});


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

// Set up storage engine
const storage = multer.diskStorage({
     destination: function  (req, file, cb) {
        const username = req.query.username;
        if (!username) {
            return cb(new Error('Username is required in query parameters'));
        }

        const userUploadPath = path.join(__dirname, username);

        // Synchronously check if directory exists, and create it if it doesn't
        try {
            if (!fs.existsSync(userUploadPath)) {
                fs.mkdirSync(userUploadPath, { recursive: true });
            }
            cb(null, userUploadPath);
        } catch (err) {
            cb(err);
        }
    },
    filename: function(req, file, cb) {
        cb(null,  randomUUID() + " - " +file.originalname);
    }
});

// Init upload
const upload = multer({
    storage: storage,
    limits: { fileSize: 100000000 }, // Limit file size to 100MB
    fileFilter: function(req, file, cb) {
        checkFileType(file, cb);
    }
}).single('video');

// Check file type
function checkFileType(file, cb) {
    // Allowed file extensions
    const filetypes = /mp4|mov|avi|mkv/;
    // Check extension
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    // Check mime type
    const mimetype = filetypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb('Error: Videos Only!');
    }
}

// Set up the POST route to handle file uploads
app.post('/upload', (req, res) => {
    console.log(req.query.username)
    upload(req, res, async (err) => {
        if (err) {
            res.status(400).send({msg: err});
        } else {
            if (req.file === undefined) {
                res.status(400).send({msg: 'No file selected!'});
            } else {

                const inputPath = path.join(req.file.path);
                console.log("1234 " + inputPath);
                const outputPaths = [
                    {path: path.join(__dirname, req.query.username, `720p-${req.file.filename}`), resolution: '1280x720'},
                    {path: path.join(__dirname, req.query.username, `480p-${req.file.filename}`), resolution: '854x480'},
                    {path: path.join(__dirname, req.query.username, `360p-${req.file.filename}`), resolution: '640x360'},
                ];

                try {
                    await Promise.all(outputPaths.map(output => transcodeVideo(inputPath, output.path, output.resolution)));
                    res.status(200).send({
                        msg: 'File uploaded and transcoded!',
                        files: outputPaths.map(output => output.path)
                    });
                } catch (transcodeError) {
                    res.status(500).send({msg: 'Error transcoding video', error: transcodeError.message});
                }
            }
        }
    });
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
//test git proxy