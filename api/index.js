const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const clean = (s) => (s || "").toLowerCase().replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").trim();

function performMatching(apiData, targetTrack, targetArtist, isJioSaavn = false) {
    if (!apiData || apiData.length === 0) return null;
    const tTitle = clean(targetTrack);
    const tArtist = clean(targetArtist);
    let bestMatch = null;
    let highestScore = 0;

    apiData.forEach(track => {
        if (!track) return;
        let rTitle = clean(isJioSaavn ? (track.name || track.title) : track.trackName);
        let rArtists =[];
        
        if (isJioSaavn) {
            if (track.artists && track.artists.primary) {
                rArtists = track.artists.primary.map(a => clean(a.name));
            } else if (track.primary_artists) {
                rArtists = track.primary_artists.split(',').map(clean);
            }
        } else {
            rArtists = [clean(track.artistName)];
        }

        let score = 0;
        let artistMatched = false;

        if (tArtist.length > 0) {
            for (let ra of rArtists) {
                if (ra === tArtist) { score += 100; artistMatched = true; break; }
                else if (ra.includes(tArtist) || tArtist.includes(ra)) { score += 80; artistMatched = true; break; }
            }
            if (!artistMatched) score = 0;
        } else {
            score += 50;
        }

        if (score > 0) {
            if (rTitle === tTitle) score += 100;
            else if (rTitle.startsWith(tTitle) || tTitle.startsWith(rTitle)) score += 80;
            else if (rTitle.includes(tTitle)) score += 50;
        }

        if (score > highestScore) {
            highestScore = score;
            bestMatch = track;
        }
    });
    return highestScore > 0 ? bestMatch : null;
}

async function getSpotifyUrl(adamId) {
    if (!adamId) return null;
    try {
        const { data } = await axios.get(`https://song.link/i/${adamId}`);
        const $ = cheerio.load(data);
        const nextData = JSON.parse($('#__NEXT_DATA__').html());
        const sections = nextData.props?.pageProps?.pageData?.sections ||[];
        for (let section of sections) {
            if (section.links) {
                const spotifyLink = section.links.find(l => l.platform === 'spotify');
                if (spotifyLink) return spotifyLink.url;
            }
        }
    } catch (e) { }
    return null;
}

async function getAppleMusicData(url) {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        const jsonData = JSON.parse($('#serialized-server-data').html());
        let moreFromArtist =[];
        let recommendations = [];

        const sections = jsonData[0]?.data?.sections ||[];
        sections.forEach(sec => {
            const headerTitle = sec.header?.item?.titleLink?.title || "";
            if (headerTitle.includes("More by")) {
                sec.items?.forEach(item => {
                    moreFromArtist.push({ title: item.titleLinks[0]?.title || "", adamId: item.contentDescriptor?.identifiers?.storeAdamID });
                });
            } else if (headerTitle.includes("You Might Also Like") || headerTitle.includes("Featured On")) {
                sec.items?.forEach(item => {
                    recommendations.push({ title: item.titleLinks?.[0]?.title || item.accessibilityLabel || "", adamId: item.contentDescriptor?.identifiers?.storeAdamID });
                });
            }
        });
        return { moreFromArtist, recommendations };
    } catch (e) {
        return { moreFromArtist: [], recommendations:[] };
    }
}

async function getJioSaavnData(title, artist) {
    try {
        const cleanQuery = title.replace(/\(From.*?\)/gi, '').replace(/- Single/gi, '').trim();
        const { data } = await axios.get(`https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(cleanQuery + " " + artist)}`);
        return performMatching(data?.data?.results ||[], cleanQuery, artist, true);
    } catch (e) { return null; }
}

app.get('/api/search', async (req, res) => {
    const { song, artist } = req.query;
    if (!song || !artist) return res.status(400).json({ error: "Missing 'song' or 'artist' parameters" });

    try {
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(song + " " + artist)}&entity=song&limit=15`;
        const { data: itunesData } = await axios.get(itunesUrl);
        const matchedTrack = performMatching(itunesData.results, song, artist, false);
        
        if (!matchedTrack) return res.status(404).json({ error: "Song not found on iTunes" });

        const trackId = matchedTrack.trackId;
        const trackViewUrl = matchedTrack.trackViewUrl;

        const [spotifyUrl, jiosaavnData, appleData] = await Promise.all([
            getSpotifyUrl(trackId),
            getJioSaavnData(song, artist),
            getAppleMusicData(trackViewUrl)
        ]);

        const processList = async (list) => {
            const processed =[];
            // Limiting to 3 to keep Vercel from timing out (10s max limit)
            for (let item of list.slice(0, 3)) { 
                const trackName = item.title.split(' - ')[0]; 
                const [itemJioSaavn, itemSpotify] = await Promise.all([
                    getJioSaavnData(trackName, ""), 
                    getSpotifyUrl(item.adamId)
                ]);
                if (itemJioSaavn) {
                    processed.push({ title: item.title, apple_id: item.adamId, spotify_url: itemSpotify, jiosaavn_data: itemJioSaavn });
                }
            }
            return processed;
        };

        const more_from_artist = await processList(appleData.moreFromArtist);
        const recommendations = await processList(appleData.recommendations);

        res.json({
            success: true,
            current_song: { title: matchedTrack.trackName, artist: matchedTrack.artistName, apple_id: trackId, spotify_url: spotifyUrl, jiosaavn_data: jiosaavnData },
            more_from_artist,
            recommendations
        });

    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

module.exports = app;
