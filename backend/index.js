const { randomUUID } = require('crypto');
const fs = require('fs');
const express = require("express");
const cors = require('cors');
const session = require('express-session');
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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 10 * 60 * 1000
    }
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});
app.use(express.static(path.join(__dirname, '../frontend')));

app.post('/register', (req, res) => {
    const { username, password } = req.body;

    const stmt = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)");

    stmt.run(username, password, function (err) {
        if (err) {
            if (err.code === 'SQLITE_CONSTRAINT') {
                res.status(409).json({ message: 'Username already exists' });
            } else {
                res.status(500).json({ message: 'Database error' });
            }
        } else {
            res.status(201).json({ message: 'User registered successfully' });
        }
    });

    stmt.finalize();
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err) {
            res.status(500).json({ message: 'Database error' });
        } else if (row) {
            req.session.user = { username: row.username };
            res.status(200).json({ message: 'Login successful' });
        } else {
            res.status(401).json({ message: 'Login failed' });
        }
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).send('Logout failed');
        }
        res.send('Logout successful');
    });
});

app.get('/getUserInfo', ensureAuthenticated, (req, res) => {
    if (req.session.user) {
        res.json({ username: req.session.user.username });
    } else {
        res.status(401).json({ message: 'User not authenticated' });
    }
});

// 用于存储转码进度
let transcodeProgress = 0;

function transcodeVideo(inputPath, outputPath, resolution) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .size(resolution)
            .on('progress', (progress) => {
                transcodeProgress = progress.percent || 0; // 更新转码进度
            })
            .on('end', () => {
                transcodeProgress = 100; // 转码完成
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error transcoding file: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const username = req.session.user.username;
        const originalFileName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const userUploadPath = path.join(__dirname, 'uploads', username, originalFileName);

        try {
            if (!fs.existsSync(userUploadPath)) {
                fs.mkdirSync(userUploadPath, { recursive: true });
            }
            req.sessionUUID = originalFileName;
            cb(null, userUploadPath);
        } catch (err) {
            cb(err);
        }
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 1073741824 },
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
}).single('video');

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

function ensureAuthenticated(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.status(401).json({ message: 'Please login to access this page' });
    }
}

app.post('/upload', ensureAuthenticated, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).send({ msg: err });
        }
        if (req.file === undefined) {
            return res.status(400).send({ msg: 'No file selected!' });
        }

        const username = req.session.user.username;
        const inputPath = path.join(req.file.path);
        const originalFileName = req.file.originalname;
        const outputPaths = [
            {
                path: path.join(__dirname, 'uploads', username, req.sessionUUID, `720p-${originalFileName}`),
                resolution: '1280x720'
            },
            {
                path: path.join(__dirname, 'uploads', username, req.sessionUUID, `480p-${originalFileName}`),
                resolution: '854x480'
            },
            {
                path: path.join(__dirname, 'uploads', username, req.sessionUUID, `360p-${originalFileName}`),
                resolution: '640x360'
            },
        ];

        try {
            await Promise.all(outputPaths.map(output => transcodeVideo(inputPath, output.path, output.resolution)));
            res.status(200).send({
                msg: 'File uploaded and transcoded!',
                files: outputPaths.map(output => ({ path: output.path, originalName: originalFileName }))
            });
        } catch (transcodeError) {
            res.status(500).send({ msg: 'Error transcoding video', error: transcodeError.message });
        }
    });
});

// 新的路由来返回转码进度
app.get('/transcodeProgress', ensureAuthenticated, (req, res) => {
    res.json({ progress: transcodeProgress });
});

app.get('/browse/:username*?', ensureAuthenticated, (req, res) => {
    const subPath = req.params[0] || '';
    if (req.params.username !== req.session.user.username) {
        res.status(401).json({ message: 'Usernames not matched' });
    } else {
        const userDirectory = path.join(__dirname, 'uploads', req.params.username, subPath);
        if (fs.existsSync(userDirectory)) {
            fs.readdir(userDirectory, { withFileTypes: true }, (err, items) => {
                if (err) {
                    return res.status(500).json({ message: 'Unable to read directory' });
                }

                let fileLinks = items.map(item => {
                    const itemPath = path.join(subPath, item.name);
                    if (item.isDirectory()) {
                        const folderName = item.name;
                        const folderUrlJoined = path.join('/browse', req.params.username, itemPath);
                        return `<li>
                            <a href="${folderUrlJoined}">${item.name}/</a>
                            <button onclick="deleteFolder('${folderName}')">Delete Folder</button>
                        </li>`;
                    } else {
                        const fileUrlJoined = path.join('/download', req.params.username, itemPath);
                        const deleteUrl = `/delete/${encodeURIComponent(req.params.username)}/${encodeURIComponent(itemPath)}`;
                        return `<li>
                            <a href="${fileUrlJoined}" download="${item.name}">${item.name}</a> 
                            <button onclick="deleteFile('${deleteUrl}')">Delete File</button>
                        </li>`;
                    }
                }).join('');

                const html = `
                <html>
                <head>
                    <title>File List</title>
                    <script>
                        function deleteFile(url) {
                            fetch(url, { method: 'DELETE' })
                                .then(response => response.json())
                                .then(data => {
                                    alert(data.message);
                                    window.location.reload();
                                })
                                .catch(error => console.error('Error:', error));
                        }

                        function deleteFolder(url) {
                            fetch(url, { method: 'DELETE' })
                                .then(response => response.json())
                                .then(data => {
                                    alert(data.message);
                                    window.location.reload();
                                })
                                .catch(error => console.error('Error:', error));
                        }
                    </script>
                </head>
                <body>
                    <h1>Files in ${path.join(req.params.username, subPath)} Directory</h1>
                    <ul>${fileLinks}</ul>
                </body>
                </html>
            `;

                res.send(html);
            });
        } else {
            res.status(404).json({ message: 'User directory not found' });
        }
    }
});

// 删除指定文件夹
app.delete('/deleteFolder/:username/:folderName', ensureAuthenticated, (req, res) => {
    const { username, folderName } = req.params;
    const userFolderPath = path.join(__dirname, 'uploads', username, folderName);

    if (req.session.user.username !== username) {
        return res.status(401).json({ message: 'Usernames do not match' });
    }

    fs.rm(userFolderPath, { recursive: true, force: true }, (err) => {
        if (err) {
            return res.status(500).json({ message: 'Failed to delete folder' });
        }
        res.json({ message: 'Folder deleted successfully' });
    });
});

app.delete('/delete/:username/:filename*', ensureAuthenticated, (req, res) => {
    const { username, filename } = req.params;
    const subPath = req.params[0] || '';
    const filePath = path.join(__dirname, 'uploads', username, filename, subPath);

    if (req.session.user.username !== username) {
        return res.status(401).json({ message: 'Usernames do not match' });
    }

    fs.unlink(filePath, (err) => {
        if (err) {
            return res.status(500).json({ message: 'Failed to delete file' });
        }
        res.json({ message: 'File deleted successfully' });
    });
});

// Route to delete entire folder
app.delete('/deleteFolder/:username', ensureAuthenticated, (req, res) => {
    const { username } = req.params;
    const userFolderPath = path.join(__dirname, 'uploads', username);

    if (req.session.user.username !== username) {
        return res.status(401).json({ message: 'Usernames do not match' });
    }

    fs.rm(userFolderPath, { recursive: true, force: true }, (err) => {
        if (err) {
            return res.status(500).json({ message: 'Failed to delete folder' });
        }
        res.json({ message: 'Folder deleted successfully' });
    });
});

// Serve files for download
app.get('/download/:username*', ensureAuthenticated, (req, res) => {
    const subPath = req.params[0] || '';
    // 检查请求的用户名是否和登录的用户名匹配
    if (req.params.username !== req.session.user.username) {
        return res.status(401).json({ message: 'Usernames do not match' });
    }
    const filePath = path.join(__dirname, '/uploads/',req.params.username, subPath);
    // Serve the file for download
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        res.download(filePath, path.basename(filePath), (err) => {
            if (err) {
                res.status(500).json({ message: 'Error downloading the file' });
            }
        });
    } else {
        res.status(404).json({ message: 'File not found' });
    }
});


app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
