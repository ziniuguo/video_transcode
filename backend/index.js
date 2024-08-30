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

// Create users table if it doesn't exist
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT)");
});

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set up session management
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 10 * 60 * 1000 // 10 minutes
    }
}));

// Set static file path correctly
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Serve index.html as the root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Registration route
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
            // Create a folder for the user upon successful registration
            const userFolderPath = path.join(__dirname, 'uploads', username);
            // Check if the folder exists; if not, create it
            if (!fs.existsSync(userFolderPath)) {
                fs.mkdirSync(userFolderPath, { recursive: true });
                console.log(`Created directory for user: ${username}`);
            }
            res.status(201).json({ message: 'User registered successfully' });
        }
    });

    stmt.finalize();
});

// Login route
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

// Logout route
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).send('Logout failed');
        }
        res.send('Logout successful');
    });
});

// Get user info route
app.get('/getUserInfo', ensureAuthenticated, (req, res) => {
    if (req.session.user) {
        res.json({ username: req.session.user.username });
    } else {
        res.status(401).json({ message: 'User not authenticated' });
    }
});

// Variable to store progress
let currentProgress = 0;

// Function to transcode video and update `currentProgress`
function transcodeVideo(inputPath, outputPath, resolution) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .size(resolution)
            .on('progress', (progress) => {
                currentProgress = progress.percent; // Update progress here
            })
            .on('end', () => {
                currentProgress = 100; // Transcoding complete
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error transcoding file: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

// Route to return current transcoding progress
app.get('/transcodingProgress', (req, res) => {
    res.json({ progress: currentProgress });
});

// Set up storage for multer
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

// Multer configuration
const upload = multer({
    storage: storage,
    limits: { fileSize: 1073741824 }, // 1 GB limit
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
}).single('video');

// Function to check file type
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

// Middleware to ensure user is authenticated
function ensureAuthenticated(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.status(401).json({ message: 'Please login to access this page' });
    }
}

// Upload route with transcoding
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

// New route to return transcoding progress
app.get('/transcodeProgress', ensureAuthenticated, (req, res) => {
    res.json({ progress: currentProgress });
});

// File browsing route
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

// Delete specific folder route
app.delete('/deleteFolder/:username/:subFolderName', ensureAuthenticated, (req, res) => {
    const { username, subFolderName } = req.params;
    const userFolderPath = path.join(__dirname, 'uploads', username, subFolderName);

    // Ensure username matches
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

// Delete specific file route
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
    // Check if the requested username matches the logged-in username
    if (req.params.username !== req.session.user.username) {
        return res.status(401).json({ message: 'Usernames do not match' });
    }
    const filePath = path.join(__dirname, '/uploads/', req.params.username, subPath);
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
