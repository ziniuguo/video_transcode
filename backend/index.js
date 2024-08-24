const express = require("express");
const multer = require("multer");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send("welcome hello warudo"));

// TODO: 把login写了，一个user对应一个uuid
// TODO: upload的时候对应一个文件夹（名字是uuid），文件夹里两个文件夹，一个upload一个transcode，是所有video
// TODO: video名字一个原名字一个加transcoded

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
    destination: './uploads/',
    filename: function(req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
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
    upload(req, res, (err) => {
        if (err) {
            res.status(400).send({ msg: err });
        } else {
            if (req.file === undefined) {
                res.status(400).send({ msg: 'No file selected!' });
            } else {
                res.status(200).send({
                    msg: 'File uploaded!',
                    file: `uploads/${req.file.filename}`
                });
            }
        }
    });
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));