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
app.use(express.urlencoded({ extended: true }));

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
    destination: function (req, file, cb) {
        const username = req.query.username;
        if (!username) {
            return cb(new Error('Username is required in query parameters'));
        }

        // Generate a UUID for the session
        const sessionUUID = randomUUID();
        const userUploadPath = path.join(__dirname, username, sessionUUID);

        // Synchronously check if directory exists, and create it if it doesn't
        try {
            if (!fs.existsSync(userUploadPath)) {
                fs.mkdirSync(userUploadPath, { recursive: true });
            }
            // Save the sessionUUID to req for later use
            req.sessionUUID = sessionUUID;
            cb(null, userUploadPath);
        } catch (err) {
            cb(err);
        }
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
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
                const outputPaths = [
                    {
                        path: path.join(__dirname, req.query.username, req.sessionUUID, `720p-${req.file.filename}`),
                        resolution: '1280x720'
                    },
                    {
                        path: path.join(__dirname, req.query.username, req.sessionUUID, `480p-${req.file.filename}`),
                        resolution: '854x480'
                    },
                    {
                        path: path.join(__dirname, req.query.username, req.sessionUUID, `360p-${req.file.filename}`),
                        resolution: '640x360'
                    },
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


// Middleware to authenticate user using query parameters
function authenticateUser(req, res, next) {
    const { username, password } = req.query;

    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
    }

    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err) {
            return res.status(500).json({ message: 'Database error' });
        } else if (row) {
            req.username = username;
            next();
        } else {
            res.status(401).json({ message: 'Invalid username or password' });
        }
    });
}

// Serve directory listing with download links and folder navigation
app.get('/browse/:username*?', authenticateUser, (req, res) => {
    // Ensure the path is properly handled
    const subPath = req.params[0] || ''; // Handle the case where there is no subpath
    // console.log(req.params.username);console.log(req.query.username);
    if (req.params.username !== req.query.username) {
        res.status(401).json({ message: 'Usernames not matched' });
    } else {
        const userDirectory = path.join(__dirname, req.params.username, subPath);
        // Check if the directory exists
        if (fs.existsSync(userDirectory)) {
            fs.readdir(userDirectory, { withFileTypes: true }, (err, items) => {
                if (err) {
                    return res.status(500).json({ message: 'Unable to read directory' });
                }

                // Create an HTML page with links to download each file or navigate into each folder
                let fileLinks = items.map(item => {
                    const itemPath = path.join(subPath, item.name);
                    if (item.isDirectory()) {
                        // Folder: provide link to navigate into the folder
                        const folderUrlJoined =  path.join('/browse', req.params.username, itemPath+ '?username='+ req.query.username +'&password='+req.query.password);
                        return `<li><a href="${folderUrlJoined}">${item.name}/</a></li>`;
                    } else {
                        // File: provide link to download the file
                        const fileUrlJoined = path.join('/download', req.params.username, itemPath+ '?username='+ req.query.username +'&password='+req.query.password);
                        return `<li><a href="${fileUrlJoined}" download="${item.name}">${item.name}</a></li>`;
                    }
                }).join('');

                const html = `
                <html>
                <head>
                    <title>File List</title>
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

// Serve files for download
app.get('/download/:username*', authenticateUser, (req, res) => {
    const subPath = req.params[0] || '';
    const filePath = path.join(__dirname, req.params.username, subPath);

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
//test git proxy