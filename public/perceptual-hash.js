// perceptual-hash.js — Shutter Soul Duplicate Image Detection
// ─────────────────────────────────────────────────────────────
// Uses a THREE-HASH VOTING SYSTEM (pHash + aHash + dHash).
// At least 2-of-3 hashes must match before an image is flagged
// as a duplicate, making the check robust against compression,
// minor resizing, and format conversion.
//
// ✅ HOW HASHES ARE STORED
//   Hashes are saved directly inside the photo's Firestore document:
//   dailyUploads/{monthYear}/{userId}/{date}  →  { pHash, aHash, dHash, ... }
//   No separate collection is needed.
//
// ✅ PUBLIC API (called from index.html)
//   window.checkImageDuplicate(file, db, currentUserId)
//     → Promise<{ isDuplicate, reason, matchedDoc? }>
//
//   window.saveImageHashes(photoDocRef, hashes)
//     → Promise<void>   (call after setDoc succeeds in Step 5)

// ─────────────────────────────────────────────────────────────
// SECTION 1 — LOW-LEVEL HASH ALGORITHMS
// ─────────────────────────────────────────────────────────────

const _PH = {
    // Draw image onto a small canvas and return grayscale pixel array
    _getGrayscale(img, w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        // Disable smoothing for consistent pixel sampling
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const g = new Float32Array(w * h);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            // Luminance formula (ITU-R BT.601)
            g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
        return g;
    },

    // ── Average Hash (aHash) — 8×8, 64-bit ───────────────────
    // Extremely fast. Good at catching exact re-uploads.
    aHash(img) {
        const g = this._getGrayscale(img, 8, 8);
        const mean = g.reduce((a, b) => a + b, 0) / g.length;
        let h = '';
        for (const v of g) h += v >= mean ? '1' : '0';
        return h;
    },

    // ── Difference Hash (dHash) — 9×8 → 64-bit ───────────────
    // Captures gradient direction. Handles brightness/contrast shifts.
    dHash(img) {
        const g = this._getGrayscale(img, 9, 8);
        let h = '';
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                h += g[row * 9 + col] > g[row * 9 + col + 1] ? '1' : '0';
            }
        }
        return h;
    },

    // ── Perceptual Hash (pHash) — DCT-based, 64-bit ───────────
    // Most robust. Handles JPEG compression, minor colour shifts.
    pHash(img) {
        const SIZE = 32;
        const g = this._getGrayscale(img, SIZE, SIZE);

        // 2-D DCT (only compute top-left 8×8 — O(n²) per coefficient)
        const dct = [];
        for (let u = 0; u < 8; u++) {
            for (let v = 0; v < 8; v++) {
                let sum = 0;
                for (let x = 0; x < SIZE; x++) {
                    for (let y = 0; y < SIZE; y++) {
                        sum += g[x * SIZE + y]
                            * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE))
                            * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * SIZE));
                    }
                }
                const cu = u === 0 ? 1 / Math.SQRT2 : 1;
                const cv = v === 0 ? 1 / Math.SQRT2 : 1;
                dct.push((cu * cv / 4) * sum);
            }
        }

        // Skip DC component (index 0) when computing median — it's the mean brightness
        const sorted = [...dct].slice(1).sort((a, b) => a - b);
        const mid    = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];

        let h = '';
        for (const v of dct) h += v > median ? '1' : '0';
        return h;
    },

    // ── Hamming Distance ─────────────────────────────────────
    hamming(a, b) {
        let d = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
        return d;
    }
};

// ─────────────────────────────────────────────────────────────
// SECTION 2 — THRESHOLDS  (tune here if needed)
// ─────────────────────────────────────────────────────────────
//
//  Lower  = stricter  (fewer false positives, might miss some dupes)
//  Higher = looser    (catches more dupes, might flag different photos)
//
//  Tested against: JPEG re-saves, WhatsApp compression, minor crops,
//  brightness/contrast tweaks, screenshot re-uploads.
//
const THRESHOLDS = {
    aHash: 8,   // out of 64 — catches near-exact matches
    dHash: 10,  // out of 64 — handles gradient shifts
    pHash: 12,  // out of 64 — handles frequency-domain compression artefacts
    // An image is flagged when AT LEAST 2 of the 3 hashes are within threshold
    votesNeeded: 2
};

// ─────────────────────────────────────────────────────────────
// SECTION 3 — LOAD IMAGE FROM FILE
// ─────────────────────────────────────────────────────────────

function _fileToImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
        img.src     = url;
    });
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — GENERATE ALL THREE HASHES FROM A FILE
// ─────────────────────────────────────────────────────────────

async function generateHashes(file) {
    const img = await _fileToImage(file);
    return {
        aHash: _PH.aHash(img),
        dHash: _PH.dHash(img),
        pHash: _PH.pHash(img)
    };
}

// ─────────────────────────────────────────────────────────────
// SECTION 5 — COMPARE A CANDIDATE HASH AGAINST A STORED HASH
// Returns true if they are duplicates (2-of-3 vote)
// ─────────────────────────────────────────────────────────────

function _isDuplicatePair(candidate, stored) {
    // Guard: skip if any hash is missing (old photo docs may not have them)
    if (!stored.aHash || !stored.dHash || !stored.pHash) return false;

    let votes = 0;
    if (_PH.hamming(candidate.aHash, stored.aHash) <= THRESHOLDS.aHash) votes++;
    if (_PH.hamming(candidate.dHash, stored.dHash) <= THRESHOLDS.dHash) votes++;
    if (_PH.hamming(candidate.pHash, stored.pHash) <= THRESHOLDS.pHash) votes++;

    return votes >= THRESHOLDS.votesNeeded;
}

// ─────────────────────────────────────────────────────────────
// SECTION 6 — FIRESTORE SCAN
// Checks the candidate hashes against:
//   (a) ALL of the current user's past uploads (catches self re-uploads)
//   (b) ALL users' uploads this month (catches copying someone else's photo)
// ─────────────────────────────────────────────────────────────

async function _scanFirestore(candidateHashes, db, currentUserId) {
    // Dynamically import Firestore helpers (same CDN already used by index.html)
    const { collection, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js'
    );

    const now      = new Date();
    const monthsFetch = [];

    // Scan this month + the previous 5 months to cover any recent re-upload attempts
    for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        monthsFetch.push(d.toISOString().slice(0, 7));
    }

    // --- Pass A: check current user's OWN uploads across all 6 months ---
    for (const monthYear of monthsFetch) {
        try {
            const snap = await getDocs(
                collection(db, `dailyUploads/${monthYear}/${currentUserId}`)
            );
            for (const docSnap of snap.docs) {
                const data = docSnap.data();
                if (_isDuplicatePair(candidateHashes, data)) {
                    return {
                        isDuplicate: true,
                        reason: `You already uploaded this photo on ${docSnap.id} (${monthYear}). Each photo must be original and unique!`,
                        matchedDoc: docSnap.id
                    };
                }
            }
        } catch (_) { /* skip month on permission error */ }
    }

    // --- Pass B: check THIS month's uploads from ALL users ---
    const currentMonthYear = now.toISOString().slice(0, 7);
    try {
        // We need all users — fetch the users collection to get their IDs
        const usersSnap = await getDocs(collection(db, 'users'));
        for (const userDoc of usersSnap.docs) {
            const uid = userDoc.id;
            if (uid === currentUserId) continue; // already checked in Pass A

            try {
                const uploadsSnap = await getDocs(
                    collection(db, `dailyUploads/${currentMonthYear}/${uid}`)
                );
                for (const docSnap of uploadsSnap.docs) {
                    const data = docSnap.data();
                    if (_isDuplicatePair(candidateHashes, data)) {
                        const uploaderName = userDoc.data().displayName || 'another user';
                        return {
                            isDuplicate: true,
                            reason: `This photo is too similar to one already uploaded by ${uploaderName} this month. Please submit an original photo.`,
                            matchedDoc: docSnap.id
                        };
                    }
                }
            } catch (_) { /* skip user on error */ }
        }
    } catch (_) { /* skip pass B on error */ }

    return { isDuplicate: false };
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Call this BEFORE uploading to ImgBB.
 * Generates hashes from the local file and checks against Firestore.
 *
 * @param {File}   file          - The selected image file
 * @param {object} db            - Firestore db instance (already initialised)
 * @param {string} currentUserId - firebase currentUser.uid
 * @returns {Promise<{ isDuplicate: boolean, reason?: string, hashes?: object }>}
 */
window.checkImageDuplicate = async function(file, db, currentUserId) {
    try {
        console.log('🔍 Generating perceptual hashes...');
        const hashes = await generateHashes(file);
        console.log('🔍 Hashes generated:', {
            aHash: hashes.aHash.slice(0, 16) + '…',
            dHash: hashes.dHash.slice(0, 16) + '…',
            pHash: hashes.pHash.slice(0, 16) + '…'
        });

        const result = await _scanFirestore(hashes, db, currentUserId);

        if (result.isDuplicate) {
            return { isDuplicate: true, reason: result.reason };
        }

        // Return hashes so the caller can save them in Step 5
        return { isDuplicate: false, hashes };

    } catch (err) {
        // Non-blocking: if hash check itself fails, allow the upload to continue
        console.warn('⚠️ Duplicate hash check failed (upload will proceed):', err.message);
        return { isDuplicate: false, hashes: null };
    }
};

/**
 * Call this AFTER setDoc succeeds in Step 5 to store hashes on the photo doc.
 * This is what makes future checks possible.
 *
 * @param {object} photoDocRef - Firestore DocumentReference for the new photo
 * @param {object} hashes      - { aHash, dHash, pHash } returned by checkImageDuplicate
 */
window.saveImageHashes = async function(photoDocRef, hashes) {
    if (!hashes || !hashes.aHash) return; // Nothing to save
    try {
        const { updateDoc } = await import(
            'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js'
        );
        await updateDoc(photoDocRef, {
            aHash: hashes.aHash,
            dHash: hashes.dHash,
            pHash: hashes.pHash
        });
        console.log('✅ Image hashes saved to Firestore.');
    } catch (err) {
        // Hash saving is non-critical — never block the upload on this
        console.warn('⚠️ Could not save image hashes:', err.message);
    }
};