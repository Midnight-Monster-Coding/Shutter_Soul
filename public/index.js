// functions/index.js
// Firebase Cloud Functions for Shutter Soul
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

// ✅ BUG FIX 2 — Timezone-safe date helpers for Cloud Functions
// Cloud Functions run in UTC, but the app uses local dates (IST = UTC+5:30).
// We generate dates in IST so they match what the frontend writes as document IDs.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
function getISTDate(d = new Date()) {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return ist.toISOString().slice(0, 10);        // "YYYY-MM-DD" in IST
}
function getISTMonthYear(d = new Date()) {
    return getISTDate(d).slice(0, 7);             // "YYYY-MM"  in IST
}

/**
 * Scheduled function to process month-end rankings
 * Runs at midnight (00:00) on the 1st day of every month
 */
exports.monthEndProcessor = functions.pubsub
    .schedule('0 0 1 * *')
    .timeZone('UTC')
    .onRun(async (context) => {
        console.log('Starting month-end processing...');
        
        try {
            // Get previous month in IST
            const now = new Date();
            const istNow = new Date(now.getTime() + IST_OFFSET_MS);
            const lastMonthIST = new Date(istNow.getFullYear(), istNow.getMonth() - 1, 1);
            const monthYear = getISTMonthYear(lastMonthIST);
            
            console.log(`Processing rankings for: ${monthYear}`);
            
            // Step 1: Calculate final scores for all users
            const userScores = await calculateMonthlyScores(monthYear);
            
            // Step 2: Sort users by score
            const sortedUsers = Object.entries(userScores)
                .sort(([, a], [, b]) => b.totalScore - a.totalScore);
            
            console.log(`Total users: ${sortedUsers.length}`);
            
            // Step 3: Award medals to top 3
            await awardMedals(sortedUsers.slice(0, 3), monthYear);
            
            // Step 4: Archive rankings
            await archiveRankings(sortedUsers, monthYear);
            
            // Step 5: Reset monthly scores (photos are NEVER deleted — they persist forever)
            await resetMonthlyScores();
            
            console.log('Month-end processing completed successfully');
            
            // Send notification (if you implement push notifications)
            // await sendMonthEndNotifications(sortedUsers.slice(0, 3));
            
        } catch (error) {
            console.error('Error in month-end processing:', error);
            throw error;
        }
    });

/**
 * Calculate total scores for all users in a month
 */
async function calculateMonthlyScores(monthYear) {
  const userScores = {};
  const usersSnapshot = await db.collection('users').get();
  
  for (const userDoc of usersSnapshot.docs) {
    const userId = userDoc.id;
    const userData = userDoc.data();
    const uploadsRef = db.collection(`dailyUploads/${monthYear}/${userId}`);
    const uploadsSnapshot = await uploadsRef.get();
    
    if (uploadsSnapshot.empty) continue;
    
    let totalScore = 0;
    let photoCount = 0;
    
    uploadsSnapshot.forEach(doc => {
      const data = doc.data();
      // ✅ FIX Bug1: Apply Golden Hour multiplier to likes + include battleWins
      const rawLikes    = data.likes || 0;
      const multiplier  = data.goldenHourMultiplier || 1.0;
      const actualLikes = Math.round(rawLikes * multiplier);
      const battleWins  = data.battleWins || 0;
      totalScore += (data.rating || 0) + actualLikes + battleWins;
      photoCount++;
    });
    
    if (photoCount > 0) {
      userScores[userId] = {
        displayName: userData.displayName,
        photoURL: userData.photoURL,
        totalScore,
        photoCount
      };
    }
  }
  
  return userScores; // ADD THIS
} // ADD THIS CLOSING BRACE

async function awardMedals(topUsers, monthYear) {
  const medals = ['gold', 'silver', 'bronze'];
  const medalEmojis = ['🥇', '🥈', '🥉'];
  
  for (let i = 0; i < topUsers.length; i++) {
    const [userId, userData] = topUsers[i];
    const position = i + 1;
    const medal = medals[i];
    const emoji = medalEmojis[i];
    
    console.log(`${emoji} Awarding ${medal} medal to ${userData.displayName} (Score: ${userData.totalScore})`);
    
    try {
      // Store in achievements subcollection
      await db.doc(`users/${userId}/achievements/${monthYear}`).set({
        position,
        medal,
        emoji,
        score: userData.totalScore,
        photoCount: userData.photoCount,
        monthYear,
        awardedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Update main user document
      await db.doc(`users/${userId}`).update({
        [`achievements.${monthYear}`]: {
          position,
          medal,
          emoji,
          score: userData.totalScore
        },
        lastAchievement: {
          monthYear,
          position,
          medal,
          emoji
        }
      });
      
      console.log(`✅ Medal awarded to ${userData.displayName}`);
    } catch (error) {
      console.error(`❌ Error awarding medal to ${userId}:`, error);
    }
  }
}

/**
 * Archive rankings for historical records
 */
async function archiveRankings(sortedUsers, monthYear) {
  console.log(`📦 Archiving rankings for ${monthYear}...`);
  
  const batch = db.batch();
  
  sortedUsers.forEach(([userId, userData], index) => {
    const position = index + 1;
    const rankingRef = db.doc(`monthlyRankings/${monthYear}/users/${userId}`);
    
    batch.set(rankingRef, {
      userId,
      displayName: userData.displayName,
      photoURL: userData.photoURL,
      totalScore: userData.totalScore,
      photoCount: userData.photoCount,
      position,
      monthYear,
      archivedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
  
  await batch.commit();
  console.log(`✅ Archived ${sortedUsers.length} rankings`);
}

/**
 * Reset monthly scores for all users
 */
async function resetMonthlyScores() {
    const usersSnapshot = await db.collection('users').get();
    const batch = db.batch();
    
    usersSnapshot.forEach(doc => {
        batch.update(doc.ref, {
            totalScore: 0
        });
    });
    
    await batch.commit();
    console.log(`Reset scores for ${usersSnapshot.size} users`);
}

/**
 * Firestore trigger: Update rankings, streak, and lifetime score when a new photo is uploaded
 */
exports.updateRankingsOnUpload = functions.firestore
    .document('dailyUploads/{monthYear}/{userId}/{date}')
    .onCreate(async (snap, context) => {
        const { monthYear, userId, date } = context.params;
        const uploadData = snap.data();
        
        try {
            const userRef = db.doc(`users/${userId}`);
            const userSnap = await userRef.get();
            const userData = userSnap.data() || {};

            const rating = uploadData.rating || 0;

            // ─── 1. Streak Logic ──────────────────────────────────────────────
            const today = date; // "YYYY-MM-DD"
            const lastUploadDate = userData.lastUploadDate || null;
            let currentStreak = userData.currentStreak || 0;
            const longestStreak = userData.longestStreak || 0;

            if (lastUploadDate) {
                const last = new Date(lastUploadDate + 'T00:00:00Z');
                const curr = new Date(today + 'T00:00:00Z');
                const diffDays = Math.round((curr - last) / (1000 * 60 * 60 * 24));

                if (diffDays === 1) {
                    currentStreak += 1; // consecutive day
                } else if (diffDays === 0) {
                    // Same day (shouldn't happen due to 1/day limit, but guard)
                } else {
                    currentStreak = 1; // Streak broken — reset
                }
            } else {
                currentStreak = 1; // First ever upload
            }

            const newLongestStreak = Math.max(longestStreak, currentStreak);

            // ─── 2. Streak Bonus Points ───────────────────────────────────────
            // Every 5 consecutive days: +2 bonus points to THIS photo's rating
            let streakBonus = 0;
            if (currentStreak > 0 && currentStreak % 5 === 0) {
                streakBonus = 2;
                await snap.ref.update({ streakBonus, rating: admin.firestore.FieldValue.increment(streakBonus) });
                console.log(`🔥 Streak bonus of ${streakBonus} pts applied for ${userId} (${currentStreak}-day streak)`);
            }

            // ─── 3. Lifetime Score ────────────────────────────────────────────
            const lifetimeIncrement = rating + streakBonus;
            const newLifetimeScore = (userData.lifetimeScore || 0) + lifetimeIncrement;

            // Compute lifetime title
            const lifetimeTitle = _getLifetimeTitle(newLifetimeScore);

            // ─── 4. Atomic user doc update ────────────────────────────────────
            await userRef.update({
                totalScore: admin.firestore.FieldValue.increment(rating + streakBonus),
                currentStreak,
                longestStreak: newLongestStreak,
                lastUploadDate: today,
                lifetimeScore: admin.firestore.FieldValue.increment(lifetimeIncrement),
                lifetimeTitle
            });

            // ─── 5. Update ONLY this user's rank ─────────────────────────────
            // ✅ FIX (BUG 1 — O(N²) Quota Killer): Instead of recalculating
            // the ENTIRE leaderboard on every single upload (which costs
            // O(N users × their photos) reads), we now re-score only the
            // uploading user's own documents (O(1) relative to user count).
            // The position field is intentionally omitted here — absolute rank
            // positions are resolved by the frontend sorting totalScore DESC,
            // and the authoritative positions are written by monthEndProcessor.
            const userUploads = await db
                .collection(`dailyUploads/${monthYear}/${userId}`)
                .get();

            let userMonthScore = 0;
            let photoCount = 0;

            userUploads.forEach(doc => {
                const d = doc.data();
                const actualLikes = Math.round((d.likes || 0) * (d.goldenHourMultiplier || 1.0));
                userMonthScore += (d.rating || 0) + actualLikes + (d.battleWins || 0);
                photoCount++;
            });

            await db.doc(`monthlyRankings/${monthYear}/users/${userId}`).set({
                userId:       userId,
                displayName:  userData.displayName || 'Anonymous',
                photoURL:     userData.photoURL    || null,
                totalScore:   userMonthScore,
                photoCount:   photoCount,
                lastUpdated:  admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            console.log(`✅ Upload processed for ${userId} | rating=${rating} | streak=${currentStreak} | lifetime=${newLifetimeScore}`);
        } catch (error) {
            console.error('Error updating rankings:', error);
        }
    });

/**
 * Firestore trigger: Detect and prevent duplicate uploads
 */
exports.checkDuplicateImage = functions.firestore
    .document('dailyUploads/{monthYear}/{userId}/{date}')
    .onWrite(async (change, context) => {
        if (!change.after.exists) return; // Deletion
        
        const data = change.after.data();
        const { userId, date } = context.params;
        
        // Check if user already uploaded today
        if (change.before.exists) return; // Update, not creation
        
        // Check for today's date in IST
        const today = getISTDate();
        
        if (date !== today) {
            console.warn(`Upload date mismatch: ${date} vs ${today}`);
        }
        
        // Additional duplicate detection logic can be added here
        // using perceptual hashing comparison
    });

/**
 * HTTP function: Manually trigger month-end processing (for testing)
 */
exports.triggerMonthEndProcessing = functions.https.onCall(async (data, context) => {
    // Require authentication
    if (!context.auth) {
        throw new functions.https.HttpsError(
            'unauthenticated',
            'User must be authenticated'
        );
    }
    
    // Optionally: Check if user is admin
    // const userDoc = await db.doc(`users/${context.auth.uid}`).get();
    // if (!userDoc.data().isAdmin) {
    //     throw new functions.https.HttpsError('permission-denied', 'Admin only');
    // }
    
    const monthYear = data.monthYear || getISTMonthYear();

    // ✅ FIX 2: Abort if rankings for this month are already archived, to prevent retroactive score changes
    const archiveCheck = await db.collection(`monthlyRankings/${monthYear}/users`).limit(1).get();
    if (!archiveCheck.empty && data.force !== true) {
        throw new functions.https.HttpsError(
            'already-exists',
            `Rankings for ${monthYear} are already archived and cannot be recomputed.`
        );
    }

    try {
        const userScores = await calculateMonthlyScores(monthYear);
        const sortedUsers = Object.entries(userScores)
            .sort(([, a], [, b]) => b.totalScore - a.totalScore);
        
        await awardMedals(sortedUsers.slice(0, 3), monthYear);
        await archiveRankings(sortedUsers, monthYear);
        
        return {
            success: true,
            message: `Processed ${sortedUsers.length} users for ${monthYear}`,
            topThree: sortedUsers.slice(0, 3).map(([uid, data]) => ({
                userId: uid,
                displayName: data.displayName,
                score: data.totalScore
            }))
        };
    } catch (error) {
        console.error('Error in manual trigger:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

/**
 * HTTP function: Get monthly statistics
 */
exports.getMonthlyStats = functions.https.onRequest(async (req, res) => {
    // Enable CORS
    res.set('Access-Control-Allow-Origin', '*');
    
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }
    
    const monthYear = req.query.month || getISTMonthYear();
    
    try {
        const userScores = await calculateMonthlyScores(monthYear);
        const totalUsers = Object.keys(userScores).length;
        const totalPhotos = Object.values(userScores).reduce((sum, u) => sum + u.photoCount, 0);
        const averageScore = totalUsers > 0  // ✅ FIX 5: Guard against the correct variable (was: totalPhotos > 0)
            ? Object.values(userScores).reduce((sum, u) => sum + u.totalScore, 0) / totalUsers 
            : 0;
        
        res.json({
            monthYear,
            totalUsers,
            totalPhotos,
            averageScore: Math.round(averageScore * 100) / 100,
            topScorer: Object.entries(userScores)
                .sort(([, a], [, b]) => b.totalScore - a.totalScore)[0]
        });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Scheduled function: Send daily reminder to users who haven't uploaded
 * Runs at 14:30 UTC = 8:00 PM IST
 */
exports.sendDailyReminders = functions.pubsub
    .schedule('30 14 * * *') // 8 PM IST (UTC+5:30 = 14:30 UTC)
    .timeZone('UTC')
    .onRun(async (context) => {
        console.log('Sending daily upload reminders...');
        
        const today = getISTDate();
        const monthYear = getISTMonthYear();
        
        // Get all users
        const usersSnapshot = await db.collection('users').get();
        let remindersSent = 0;
        
        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            
            // Check if user uploaded today
            const uploadDoc = await db.doc(`dailyUploads/${monthYear}/${userId}/${today}`).get();
            
            if (!uploadDoc.exists) {
                // User hasn't uploaded today
                // Here you would send a push notification
                // For now, we'll just log it
                console.log(`Reminder needed for user: ${userId}`);
                remindersSent++;
                
                // TODO: Implement FCM push notification
                // await sendPushNotification(userId, 'Upload your daily photo!');
            }
        }
        
        console.log(`Sent ${remindersSent} reminders`);
    });

// ─── HELPER: Lifetime Title ──────────────────────────────────────────────────
function _getLifetimeTitle(score) {
    if (score >= 5000) return 'Visionary 🥇';
    if (score >= 2001) return 'Lens Master 🥈';
    if (score >= 501)  return 'Enthusiast 🥉';
    return 'Novice 📷';
}

/**
 * ⚡ Scheduled: Flash Challenge — creates a Firestore doc with today's challenge
 * Runs at 11:00 AM UTC daily
 */
exports.sendFlashChallenge = functions.pubsub
    .schedule('0 11 * * *')
    .timeZone('UTC')
    .onRun(async () => {
        const themes = [
            { theme: 'YELLOW', description: 'Something Yellow 🟡', bonusPoints: 15 },
            { theme: 'SHADOW', description: 'Dramatic Shadow 🌑', bonusPoints: 12 },
            { theme: 'TEXTURE', description: 'Interesting Texture 🪨', bonusPoints: 10 },
            { theme: 'REFLECTION', description: 'A Reflection 🪞', bonusPoints: 15 },
            { theme: 'NATURE', description: 'Pure Nature 🌿', bonusPoints: 10 },
            { theme: 'ARCHITECTURE', description: 'Urban Architecture 🏙️', bonusPoints: 12 },
            { theme: 'FOOD', description: 'Beautiful Food 🍜', bonusPoints: 8 },
            { theme: 'MOTION', description: 'Something in Motion 💨', bonusPoints: 15 },
            { theme: 'MINIMAL', description: 'Minimalist Shot ⬜', bonusPoints: 10 },
            { theme: 'BLUE', description: 'Something Blue 💙', bonusPoints: 12 },
        ];
        const chosen = themes[Math.floor(Math.random() * themes.length)];
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 6);

        await db.doc('flashChallenges/active').set({
            theme: chosen.theme,
            description: chosen.description,
            bonusPoints: chosen.bonusPoints,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
            date: getISTDate()
        });

        console.log(`⚡ Flash Challenge: ${chosen.description} (+${chosen.bonusPoints} pts)`);

        // Broadcast FCM to all users
        try {
            const usersSnap = await db.collection('users').get();
            const tokens = [];
            usersSnap.forEach(d => { if (d.data().fcmToken) tokens.push(d.data().fcmToken); });
            if (tokens.length > 0) {
                await admin.messaging().sendMulticast({
                    tokens,
                    notification: {
                        title: '📸 Flash Challenge!',
                        body: `Capture: ${chosen.description} in the next 6 hours for +${chosen.bonusPoints} bonus points!`
                    },
                    data: { type: 'flashChallenge', theme: chosen.theme }
                });
            }
        } catch (err) { console.error('FCM flash challenge error:', err); }
    });

// Helper function for push notifications (to be implemented)
async function sendPushNotification(userId, message) {
    // Implementation with Firebase Cloud Messaging (FCM)
    // const userDoc = await db.doc(`users/${userId}`).get();
    // const fcmToken = userDoc.data().fcmToken;
    // 
    // if (fcmToken) {
    //     await admin.messaging().send({
    //         token: fcmToken,
    //         notification: {
    //             title: 'Shutter Soul',
    //             body: message
    //         }
    //     });
    // }
}

/**
 * ✅ NEW: Send FCM Push Notification on new Chat Message
 */
exports.sendChatNotification = functions.firestore
    .document('chats/{chatId}/messages/{messageId}')
    .onCreate(async (snap, context) => {
        const message = snap.data();
        
        const recipientId = message.recipientId;
        const senderName = message.senderName || 'Someone';
        const text = message.imageUrl ? '📷 Sent a photo' : message.text;

        try {
            const userDoc = await db.doc(`users/${recipientId}`).get();
            const fcmToken = userDoc.data().fcmToken;
            const isOnline = userDoc.data().isOnline;
            
            // Only send if they have a token and are currently offline
            if (fcmToken && !isOnline) {
                await admin.messaging().send({
                    token: fcmToken,
                    notification: {
                        title: senderName,
                        body: text
                    },
                    data: {
                        type: 'chat',
                        senderId: message.senderId,
                        chatId: message.chatId
                    }
                });
                
                // Mark as delivered since it reached their device
                await snap.ref.update({ status: 'delivered' });
            }
        } catch (error) {
            console.error('Error sending chat push notification:', error);
        }
    });

/**
 * 🔄 BUG 1 FIX — Frozen Leaderboard:
 * Ensures the global leaderboard is instantly updated when a photo
 * receives a Like, a Judge Vote, or is Deleted.
 * The onCreate trigger in updateRankingsOnUpload only fires on new uploads,
 * so without this onWrite trigger the score in monthlyRankings stays frozen
 * at the upload-time value and never reflects subsequent likes or deletions.
 */
exports.syncRankingsOnInteraction = functions.firestore
    .document('dailyUploads/{monthYear}/{userId}/{date}')
    .onWrite(async (change, context) => {
        // Skip brand-new uploads — those are already handled by updateRankingsOnUpload
        if (!change.before.exists && change.after.exists) return;

        const { monthYear, userId } = context.params;

        try {
            const userUploads = await db
                .collection(`dailyUploads/${monthYear}/${userId}`)
                .get();

            let userMonthScore = 0;
            let photoCount = 0;

            userUploads.forEach(doc => {
                const d = doc.data();
                const actualLikes = Math.round((d.likes || 0) * (d.goldenHourMultiplier || 1.0));
                userMonthScore += (d.rating || 0) + actualLikes + (d.battleWins || 0);
                photoCount++;
            });

            // Sync the fresh score to the global leaderboard
            await db.doc(`monthlyRankings/${monthYear}/users/${userId}`).set({
                totalScore:  userMonthScore,
                photoCount:  photoCount,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            console.log(`🔄 Synced leaderboard for ${userId} -> New Score: ${userMonthScore}`);
        } catch (error) {
            console.error('Error syncing rankings on interaction:', error);
        }
    });