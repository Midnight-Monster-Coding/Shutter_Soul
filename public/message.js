import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    getFirestore, collection, addDoc, query, onSnapshot, orderBy,
    updateDoc, doc, setDoc, getDoc, serverTimestamp, getDocs, limit,
    where, arrayUnion, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
    getDatabase, ref, onDisconnect, set, onValue, get,
    serverTimestamp as rtdbServerTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js';

// ✅ NEW: Inject CSS for loading spinner and clean image viewer
(function injectChatStyles() {
    const styles = `
    /* Sleek Loading Spinner in Bubble */
    .bubble-loader {
        border: 4px solid #f3f3f3;
        border-top: 4px solid #0cc0df;
        border-radius: 50%;
        width: 30px;
        height: 30px;
        animation: bubbleSpin 1s linear infinite;
        margin: 10px auto;
    }
    @keyframes bubbleSpin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }

    /* Remove Border from Sent/Received Images */
    .message-image {
        border: none !important;
        border-radius: 12px;
        padding: 0 !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        cursor: pointer;
        display: block;
        max-width: 100%;
    }

    /* Style the new Viewer Action Buttons */
    .viewer-btn {
        background: rgba(255,255,255,0.15);
        border: none;
        color: white;
        font-size: 18px;
        cursor: pointer;
        padding: 10px;
        border-radius: 50%;
        width: 45px;
        height: 45px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
        margin-left: 10px;
    }
    .viewer-btn:hover {
        background: rgba(255,255,255,0.3);
    }

    /* ✅ FIX: Lift mobile input box and use dynamic viewport */
    @media (max-width: 768px) {
        .chat-window {
            height: 100% !important;
        }
        .message-input-container {
            padding-bottom: calc(20px + env(safe-area-inset-bottom)) !important;
        }
    }
    `;
    const styleSheet = document.createElement("style");
    styleSheet.innerText = styles;
    document.head.appendChild(styleSheet);
})();

// ─── Firebase ──────────────────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey:            "AIzaSyD3rQ3l-AlnJhCOCcA7_h2rQHfdxDz1Of0",
    authDomain:        "shutter-soul.firebaseapp.com",
    projectId:         "shutter-soul",
    storageBucket:     "shutter-soul.appspot.com",
    messagingSenderId: "602126305011",
    appId:             "1:602126305011:web:c059836dae27a208e95986",
    measurementId:     "G-MSSSHJKN28",
    databaseURL:       "https://shutter-soul-default-rtdb.asia-southeast1.firebasedatabase.app"
};
const app       = initializeApp(firebaseConfig);
const auth      = getAuth(app);
const db        = getFirestore(app);
const rtdb      = getDatabase(app);
const messaging = getMessaging(app);

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser              = null;
let currentChatUser          = null;
let globalUsersList          = [];
let onlineUsers              = new Set();
let typingUsers              = new Map();
let lastMessages             = new Map();
let unreadCounts             = new Map();
let displayedMessages        = new Set();

let messageListeners         = [];
let globalMessageListeners   = [];
let typingListeners          = [];
let presenceUpdateTimer      = null;

let typingTimeout            = null;
let typingInputListener      = null;
let isTypingCurrently        = false;
let currentTypingUnsubscribe = null;

// ✅ ADD THIS: Track read receipts we've already tried to update
const attemptedReadUpdates   = new Set();

// BUG 1 FIX — chat session guard
let chatSessionId = 0;

// ─── Voice call ────────────────────────────────────────────────────────────────
let peerConnection    = null;
let localStream       = null;
let remoteStream      = null;
let activeCallId      = null;
let callUnsubscribe   = null;
let isSpeakerOn       = false;
let callTimerInterval = null;
let callStartTime     = null;

const EMAIL_FALLBACK_URL = 'https://script.google.com/macros/s/AKfycbwemuPg5nV6BroBkRZan4UEpQJZ9-nY1aT7FNy6ZJyTEriWTUX3i-NdyphGDk08UU_H/exec';
const EMAIL_SECRET       = 'xyxzw077700IABshuttersoul';

// ─── Globals for HTML onclick ──────────────────────────────────────────────────
window.sendMessage             = sendMessage;
window.openSettings            = openSettings;
window.closeChatWindow         = closeChatWindow;
window.openChat                = openChat;
window.toggleTheme             = toggleTheme;
window.switchTab               = () => renderUserList();
window.addToGeneralAndOpenChat = (u) => openChat(u);

// ═══════════════════════════════════════════════════════════════════════════════
// SKELETON LOADING
// ═══════════════════════════════════════════════════════════════════════════════
function showUserListSkeleton() {
    const list = document.getElementById('usersList');
    if (!list) return;
    const widths = [55, 68, 42, 72, 50, 63, 47];
    list.innerHTML = widths.map(w => `
        <div class="skeleton-item">
            <div class="skeleton skeleton-avatar"></div>
            <div class="skeleton-info">
                <div class="skeleton skeleton-name" style="width:${w}%"></div>
                <div class="skeleton skeleton-preview" style="width:${Math.min(w + 18, 90)}%"></div>
            </div>
            <div class="skeleton-meta">
                <div class="skeleton skeleton-time"></div>
            </div>
        </div>`).join('');
}

function showChatSkeleton() {
    const body = document.getElementById('chatMessages');
    if (!body) return;
    const msgs = [
        { side: 'received', w: '55%',  h: 44 },
        { side: 'sent',     w: '40%',  h: 40 },
        { side: 'received', w: '70%',  h: 56 },
        { side: 'received', w: '45%',  h: 40 },
        { side: 'sent',     w: '62%',  h: 44 },
        { side: 'sent',     w: '30%',  h: 40 },
    ];
    body.innerHTML = msgs.map(m => `
        <div style="display:flex;justify-content:${m.side === 'sent' ? 'flex-end' : 'flex-start'};margin-bottom:8px;">
            <div class="skeleton" style="width:${m.w};height:${m.h}px;border-radius:18px;
                border-bottom-${m.side === 'sent' ? 'right' : 'left'}-radius:4px;"></div>
        </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════════════════
function initializeTheme() { setTheme(localStorage.getItem('chatTheme') || 'dynamic'); }
function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dynamic' ? 'dark' : 'dynamic';
    setTheme(next);
    localStorage.setItem('chatTheme', next);
}
function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('themeIcon');
    const text = document.getElementById('themeText');
    if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    if (text) text.textContent = theme === 'dark' ? 'Dynamic' : 'Dark';
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMOJI
// ═══════════════════════════════════════════════════════════════════════════════
const popularEmojis = [
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
    '😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨',
    '😐','😑','😶','😏','😒','🙄','😬','🤥','😔','😕','🙁','😖','😣','😞','😓','😩',
    '😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽',
    '👍','👎','👌','🤝','👏','🙏','💪','🦾','❤️','🧡','💛','💚','💙','💜','🤎','🖤',
    '🤍','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💯','💫','⭐','🌟',
    '✨','⚡','💥','💢','💨','💤','💦','💧'
];
function initializeEmojiPicker() {
    const grid = document.getElementById('emojiGrid');
    if (!grid) return;
    grid.innerHTML = '';
    popularEmojis.forEach(e => {
        const btn = document.createElement('button');
        btn.className = 'emoji-item';
        btn.textContent = e;
        btn.onclick = () => insertEmoji(e);
        grid.appendChild(btn);
    });
}
function insertEmoji(emoji) {
    const inp = document.getElementById('messageInput');
    if (!inp) return;
    const s = inp.selectionStart, e = inp.selectionEnd;
    inp.value = inp.value.substring(0, s) + emoji + inp.value.substring(e);
    inp.setSelectionRange(s + emoji.length, s + emoji.length);
    inp.focus();
    document.getElementById('emojiPicker')?.classList.remove('show');
    inp.dispatchEvent(new Event('input'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH + BOOT
// ═══════════════════════════════════════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
    try {
        if (user) {
            currentUser = user;
            showUserListSkeleton();          // immediate skeleton while we load
            await initializeUniqueUser();
            await setupPresenceSystem();
            await loadAllUsers();            // replaces skeleton with real data
            initializeTheme();
            initializeEmojiPicker();
            setupEventListeners();
            registerForPushNotifications().catch(() => {});
            listenForIncomingCalls();
            handleCallFromURL();
        } else {
            window.location.href = 'login.html';
        }
    } catch (err) {
        console.error('❌ AUTH ERROR:', err);
    }
});

async function initializeUniqueUser() {
    try {
        const userRef = doc(db, 'users', currentUser.uid);
        const snap    = await getDoc(userRef);
        let displayName = currentUser.displayName || currentUser.email.split('@')[0];
        let gender = 'male', photoURL = null;
        if (snap.exists()) {
            const d = snap.data();
            displayName = d.customName || d.name || d.displayName || displayName;
            gender      = d.gender    || gender;
            photoURL    = d.photoURL  || null;
            await setDoc(userRef, { lastActive: serverTimestamp(), isOnline: true }, { merge: true });
        }
        const nameEl   = document.getElementById('currentUserName');
        const avatarEl = document.getElementById('currentUserAvatar');
        if (nameEl)   nameEl.textContent = displayName;
        if (avatarEl) setAvatarContent(avatarEl, displayName, photoURL);
        localStorage.setItem('userName',   displayName);
        localStorage.setItem('userGender', gender);
    } catch (err) {
        console.error('❌ User init error:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESENCE — RTDB, instant dot updates
// ═══════════════════════════════════════════════════════════════════════════════
async function setupPresenceSystem() {
    try {
        const myRef      = ref(rtdb, `presence/${currentUser.uid}`);
        const offlineObj = { state: 'offline', last_changed: rtdbServerTimestamp(), userId: currentUser.uid };
        const onlineObj  = { state: 'online',  last_changed: rtdbServerTimestamp(), userId: currentUser.uid };

        // 1. Setup automatic disconnect handling
        onValue(ref(rtdb, '.info/connected'), (snap) => {
            if (snap.val() !== true) return;
            onDisconnect(myRef).set(offlineObj)
                .then(() => set(myRef, onlineObj))
                .catch(err => console.error('❌ Presence write error:', err));
        });

        // 2. Listen to global presence changes to instantly update UI
        onValue(ref(rtdb, 'presence'), (snap) => {
            const data = snap.val() || {};
            const next = new Set();

            Object.entries(data).forEach(([docId, d]) => {
                if (d?.state === 'online') {
                    if (d.userId) next.add(d.userId);
                    next.add(docId);
                }
            });

            const prev = onlineUsers;
            onlineUsers = next;

            // Instantly update the DOM dots without full re-renders
            globalUsersList.forEach(u => {
                const was = prev.has(u.uid);
                const now = next.has(u.uid);
                if (was !== now) {
                    updateDotForUser(u.uid, now);
                    updatePreviewForUser(u.uid);
                }
            });
            if (currentChatUser) updateChatHeaderStatus();
        }, err => console.error('❌ Presence listener error:', err));

        // 3. Force state changes when minimizing/maximizing the app
        document.addEventListener('visibilitychange', () => {
            set(myRef, {
                state: document.hidden ? 'offline' : 'online',
                last_changed: rtdbServerTimestamp(),
                userId: currentUser.uid
            }).catch(() => {});
        });

        // Keep-alive ping
        if (presenceUpdateTimer) clearInterval(presenceUpdateTimer);
        presenceUpdateTimer = setInterval(() => {
            if (!document.hidden && navigator.onLine) {
                set(myRef, {
                    state: 'online',
                    last_changed: rtdbServerTimestamp(),
                    userId: currentUser.uid
                }).catch(() => {});
            }
        }, 30000);
    } catch (err) {
        console.error('❌ PRESENCE SETUP ERROR:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD ALL USERS
// ═══════════════════════════════════════════════════════════════════════════════
async function loadAllUsers() {
    try {
        const snap = await getDocs(query(collection(db, 'users')));
        globalUsersList = [];
        const seen = new Set();

        snap.forEach(d => {
            const data = d.data();
            const uid  = data.uid || d.id;
            if (uid === currentUser.uid || seen.has(uid) || d.id !== uid) return;
            seen.add(uid);
            globalUsersList.push({
                uid,
                displayName: data.customName || data.name || data.displayName || data.email?.split('@')[0] || 'User',
                photoURL:    data.photoURL || null,
                gender:      data.gender   || 'male',
                email:       data.email    || ''
            });
        });

        globalUsersList.forEach(u => { if (!unreadCounts.has(u.uid)) unreadCounts.set(u.uid, 0); });

        // 1. RENDER IMMEDIATELY (instantly shows users without waiting for messages)
        renderUserList();

        // 2. FETCH DATA IN BACKGROUND (won't block the UI)
        loadLastMessages().then(() => {
            initializeUnreadCounts().then(() => {
                renderUserList(); // Re-sort and render with actual message data
                setupUnreadListeners();
            });
        });

        setupTypingListeners();

    } catch (err) {
        console.error('❌ Error loading users:', err);
        const el = document.getElementById('usersList');
        if (el) el.innerHTML = '<div class="no-users">Error loading users. Please refresh.</div>';
    }
}

async function loadLastMessages() {
    lastMessages.clear();
    await Promise.all(globalUsersList.map(async u => {
        try {
            const chatId = makeChatId(u.uid);
            const q = query(collection(db, 'chats', chatId, 'messages'), orderBy('timestamp', 'desc'), limit(1));
            const s = await getDocs(q);
            if (!s.empty) lastMessages.set(u.uid, s.docs[0].data());
        } catch (_) {}
    }));
}

async function initializeUnreadCounts() {
    await Promise.all(globalUsersList.map(async u => {
        try {
            const chatId = makeChatId(u.uid);
            const lastReadSnap = await getDoc(doc(db, 'lastRead', `${chatId}_${currentUser.uid}`));
            let count = 0;

            if (lastReadSnap.exists() && lastReadSnap.data().timestamp) {
                const lastReadTime = lastReadSnap.data().timestamp;

                // Simple query using only ONE field to bypass Firestore indexing errors
                const q = query(
                    collection(db, 'chats', chatId, 'messages'),
                    where('timestamp', '>', lastReadTime)
                );

                const s = await getDocs(q);
                // Filter locally
                s.forEach(doc => {
                    if (doc.data().senderId === u.uid) count++;
                });
            } else {
                // Fallback if no lastReadTime exists
                const q = query(
                    collection(db, 'chats', chatId, 'messages'),
                    orderBy('timestamp', 'desc'),
                    limit(30)
                );
                const s = await getDocs(q);
                s.forEach(doc => {
                    const d = doc.data();
                    if (d.senderId === u.uid && d.status !== 'read') count++;
                });
            }
            unreadCounts.set(u.uid, count);
        } catch (err) {
            console.error('❌ Unread count index error:', err);
            unreadCounts.set(u.uid, 0); // Fail gracefully
        }
    }));
}

// ─── Background unread listeners (one per user) ───────────────────────────────
// BUG 2 FIX: listenerReady skips the initial snapshot Firestore always fires.
// Without this, every existing message fires as 'added' and inflates the count.
function setupUnreadListeners() {
    globalMessageListeners.forEach(u => { try { u(); } catch (_) {} });
    globalMessageListeners = [];

    globalUsersList.forEach(user => {
        const chatId = makeChatId(user.uid);
        const q = query(
            collection(db, 'chats', chatId, 'messages'),
            orderBy('timestamp', 'desc'),
            limit(1)
        );

        let listenerReady = false; // ← BUG 2 FIX

        const unsub = onSnapshot(q, snap => {
            if (!listenerReady) {
                // ── INITIAL SNAPSHOT ──────────────────────────────────────────
                // Firestore always fires one immediate snapshot with existing data.
                // Use it only to sync lastMessages. NEVER touch unreadCounts here
                // because initializeUnreadCounts() already set them correctly.
                snap.forEach(d => {
                    const msg = d.data();
                    if (msg?.timestamp) lastMessages.set(user.uid, msg);
                });
                listenerReady = true;
                return; // ← skip all unread logic
            }

            // ── SUBSEQUENT FIRES = real new messages ───────────────────────
            snap.docChanges().forEach(change => {
                const msg = change.doc.data();

                // Handle both new and modified (deleted) messages for the sidebar preview
                if (change.type === 'added' || change.type === 'modified') {
                    lastMessages.set(user.uid, msg);
                    if (change.type === 'modified') {
                        renderUserList(); // Instantly update sidebar if message changes to "Deleted"
                    }
                }

                if (change.type !== 'added') return; // Keep existing logic for unread badges below

                if (msg.senderId === user.uid && msg.recipientId === currentUser.uid) {
                    if (currentChatUser?.uid === user.uid) {
                        markMessagesAsRead(user.uid);
                    } else {
                        unreadCounts.set(user.uid, (unreadCounts.get(user.uid) || 0) + 1);
                        renderUserList();
                    }
                } else if (msg.senderId === currentUser.uid && msg.recipientId === user.uid) {
                    renderUserList(); // re-sort to top on outgoing message
                }
            });
        });

        globalMessageListeners.push(unsub);
    });
}

// ─── Typing listeners ─────────────────────────────────────────────────────────
function setupTypingListeners() {
    typingListeners.forEach(u => { try { u(); } catch (_) {} });
    typingListeners = [];

    globalUsersList.forEach(user => {
        const chatId = makeChatId(user.uid);
        const unsub  = onSnapshot(doc(db, 'typing', chatId), snap => {
            try {
                const data      = snap.data() || {};
                const wasTyping = typingUsers.get(user.uid) || false;
                const isTyping  = !!(data[user.uid]?.typing === true);
                typingUsers.set(user.uid, isTyping);
                if (isTyping !== wasTyping) {
                    updatePreviewForUser(user.uid);  // surgical
                    if (currentChatUser?.uid === user.uid) {
                        updateChatHeaderStatus();
                        updateChatTypingIndicator();
                    }
                }
            } catch (_) {}
        });
        typingListeners.push(unsub);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER LIST RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
function getTimestamp(msg) {
    if (!msg) return 0;
    // ✅ FIX: If the serverTimestamp is still pending locally, use the current time
    if (!msg.timestamp) return Date.now(); 
    
    const t = msg.timestamp;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (t instanceof Date) return t.getTime();
    if (typeof t === 'number') return t;
    if (t?.seconds) return t.seconds * 1000;
    return Date.now();
}

function getSortedUsers() {
    return [...globalUsersList].sort((a, b) => {
        const au = unreadCounts.get(a.uid) || 0;
        const bu = unreadCounts.get(b.uid) || 0;
        if (au > 0 && bu === 0) return -1;
        if (bu > 0 && au === 0) return  1;
        const at = getTimestamp(lastMessages.get(a.uid));
        const bt = getTimestamp(lastMessages.get(b.uid));
        if (at !== bt) return bt - at;
        const ao = onlineUsers.has(a.uid) ? 1 : 0;
        const bo = onlineUsers.has(b.uid) ? 1 : 0;
        if (ao !== bo) return bo - ao;
        return a.displayName.localeCompare(b.displayName);
    });
}

function renderUserList() {
    const list = document.getElementById('usersList');
    if (!list) return;
    const sorted = getSortedUsers();
    if (sorted.length === 0) {
        list.innerHTML = '<div class="no-users">No users found</div>';
        return;
    }
    list.innerHTML = '';
    sorted.forEach(u => list.appendChild(buildUserItem(u)));
}

function buildUserItem(user) {
    const isOnline = onlineUsers.has(user.uid);
    const isTyping = typingUsers.get(user.uid) || false;
    const unread   = unreadCounts.get(user.uid) || 0;
    const lastMsg  = lastMessages.get(user.uid);
    const isActive = currentChatUser?.uid === user.uid;

    const item = document.createElement('div');
    item.className = `chat-item ${user.gender === 'male' ? 'male-user' : 'female-user'}${isActive ? ' active' : ''}`;
    item.setAttribute('data-uid', user.uid);

    const wrap   = document.createElement('div');  wrap.className = 'avatar-container';
    const avatar = document.createElement('div');
    avatar.className = `chat-avatar ${user.gender === 'male' ? 'male-avatar' : 'female-avatar'}`;
    if (user.photoURL) {
        const img = document.createElement('img');
        img.src = user.photoURL; img.alt = user.displayName;
        img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
        avatar.appendChild(img);
    } else {
        avatar.textContent = (user.displayName || 'U').charAt(0).toUpperCase();
    }
    const dot = document.createElement('div');
    dot.className = isOnline ? 'online-status' : 'offline-status';
    wrap.appendChild(avatar);
    wrap.appendChild(dot);

    const info = document.createElement('div'); info.className = 'chat-info';
    const nameEl = document.createElement('div'); nameEl.className = 'chat-name';
    nameEl.textContent = user.displayName || 'Unknown';
    const preview = document.createElement('div');
    preview.className = 'chat-preview' + (isTyping ? ' typing' : '');
    preview.textContent = buildPreviewText(user.uid, isOnline, isTyping, lastMsg);
    info.appendChild(nameEl);
    info.appendChild(preview);

    const meta   = document.createElement('div'); meta.className = 'chat-meta';
    const timeEl = document.createElement('div'); timeEl.className = 'chat-time';
    timeEl.textContent = lastMsg ? getTimeAgo(lastMsg.timestamp) : (isOnline ? 'now' : '');
    meta.appendChild(timeEl);
    if (unread > 0) {
        const badge = document.createElement('div'); badge.className = 'unread-badge';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        meta.appendChild(badge);
    }

    item.appendChild(wrap);
    item.appendChild(info);
    item.appendChild(meta);
    item.addEventListener('click', () => openChat(user));
    return item;
}

function buildPreviewText(uid, isOnline, isTyping, lastMsg) {
    if (isTyping) return 'typing...';
    if (lastMsg) {
        const mine = lastMsg.senderId === currentUser.uid;
        const txt  = (lastMsg.text || '').length > 30
            ? lastMsg.text.substring(0, 30) + '...'
            : (lastMsg.text || '');
        return mine ? `You: ${txt}` : txt;
    }
    return isOnline ? 'Online' : 'Offline';
}

// Surgical: flip ONLY the dot for one uid
function updateDotForUser(uid, isOnline) {
    const item = document.querySelector(`#usersList [data-uid="${uid}"]`);
    if (!item) return;
    const dot = item.querySelector('.online-status, .offline-status');
    if (dot) dot.className = isOnline ? 'online-status' : 'offline-status';
}

// Surgical: update preview, time, badge for one uid only
function updatePreviewForUser(uid) {
    const item = document.querySelector(`#usersList [data-uid="${uid}"]`);
    if (!item) return;
    const isOnline = onlineUsers.has(uid);
    const isTyping = typingUsers.get(uid) || false;
    const lastMsg  = lastMessages.get(uid);
    const unread   = unreadCounts.get(uid) || 0;

    const preview = item.querySelector('.chat-preview');
    if (preview) {
        preview.className   = 'chat-preview' + (isTyping ? ' typing' : '');
        preview.textContent = buildPreviewText(uid, isOnline, isTyping, lastMsg);
    }
    const timeEl = item.querySelector('.chat-time');
    if (timeEl) timeEl.textContent = lastMsg ? getTimeAgo(lastMsg.timestamp) : (isOnline ? 'now' : '');

    const meta = item.querySelector('.chat-meta');
    if (meta) {
        const badge = meta.querySelector('.unread-badge');
        if (unread > 0) {
            if (badge) {
                badge.textContent = unread > 99 ? '99+' : String(unread);
            } else {
                const b = document.createElement('div'); b.className = 'unread-badge';
                b.textContent = unread > 99 ? '99+' : String(unread);
                meta.appendChild(b);
            }
        } else if (badge) {
            badge.remove();
        }
    }
}

function filterUsers() {
    const term = (document.getElementById('usersSearchInput')?.value || '').toLowerCase().trim();
    const list = document.getElementById('usersList');
    if (!list) return;
    if (!term) { renderUserList(); return; }
    const filtered = getSortedUsers().filter(u =>
        u.displayName.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)
    );
    list.innerHTML = '';
    if (filtered.length === 0) { list.innerHTML = '<div class="no-users">No users found</div>'; return; }
    filtered.forEach(u => list.appendChild(buildUserItem(u)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN CHAT
// ═══════════════════════════════════════════════════════════════════════════════
async function openChat(user) {
    try {
        // BUG 1 FIX: Increment FIRST — any in-flight old listener that fires
        // after this point will see a mismatched sessionId and self-abort.
        chatSessionId++;
        const mySessionId = chatSessionId;

        messageListeners.forEach(u => { try { u(); } catch (_) {} });
        messageListeners = [];
        displayedMessages.clear();
        detachTypingListener();
        if (currentTypingUnsubscribe) {
            try { currentTypingUnsubscribe(); } catch (_) {}
            currentTypingUnsubscribe = null;
        }

        currentChatUser = user;
        await markMessagesAsRead(user.uid);

        const nameEl   = document.getElementById('chatUserName');
        const avatarEl = document.getElementById('chatUserAvatar');
        if (nameEl) nameEl.textContent = user.displayName;
        if (avatarEl) {
            setAvatarContent(avatarEl, user.displayName, user.photoURL);
            const old = avatarEl.querySelector('.online-status, .offline-status');
            if (old) old.remove();
            const dot = document.createElement('div');
            dot.className = onlineUsers.has(user.uid) ? 'online-status' : 'offline-status';
            avatarEl.appendChild(dot);
        }
        updateChatHeaderStatus();

        document.getElementById('chatModal').style.display = 'block';

        showChatSkeleton();                      // show skeleton while messages load
        loadChatMessages(mySessionId);           // pass session id for guard

        resetTypingStatus();
        attachTypingListener();
        attachIncomingTypingListener(user.uid);

        document.querySelectorAll('#usersList .chat-item').forEach(el => el.classList.remove('active'));
        const myItem = document.querySelector(`#usersList [data-uid="${user.uid}"]`);
        if (myItem) myItem.classList.add('active');

        setTimeout(() => {
            const inp = document.getElementById('messageInput');
            if (inp) { inp.focus(); setupAutoResize(inp); }
        }, 100);
    } catch (err) {
        console.error('❌ Open chat error:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT MESSAGES — session-guarded, append-only after first load
// BUG 1 FIX: sessionId check aborts stale listeners before any DOM write
// ═══════════════════════════════════════════════════════════════════════════════
let chatMessageLimit = 50; 

function loadChatMessages(sessionId, keepScroll = false) {
    if (!currentChatUser) return;
    const chatId     = makeChatId(currentChatUser.uid);
    const sessionUid = currentChatUser.uid; 

    if (!keepScroll) chatMessageLimit = 50;

    const q = query(collection(db, 'chats', chatId, 'messages'), orderBy('timestamp', 'desc'), limit(chatMessageLimit));

    let isFirstLoad = true;
    let selfUnsub   = null;

    const unsub = onSnapshot(q, snap => {
        if (chatSessionId !== sessionId || !currentChatUser || currentChatUser.uid !== sessionUid) {
            // Delay by 0ms so selfUnsub is guaranteed to be assigned before we call it.
            // onSnapshot can fire synchronously on the first tick (from local cache),
            // before the `selfUnsub = unsub` line below has executed.
            setTimeout(() => { if (selfUnsub) selfUnsub(); }, 0);
            return;
        }

        try {
            const chatBody = document.getElementById('chatMessages');
            if (!chatBody) return;

            const batch = writeBatch(db);
            let hasUnreadUpdates = false;

            // 1. Categorize incoming changes
            const addedChanges = [];
            const modifiedChanges = [];
            
            snap.docChanges().forEach(change => {
                if (change.type === 'added' && !displayedMessages.has(change.doc.id)) {
                    addedChanges.push(change);
                } else if (change.type === 'modified') {
                    modifiedChanges.push(change);
                }
            });

            // 🚨 FIX: Detect partial cache-misses and server backfills
            // Force a clean chronological redraw on first load, manual pagination, or bulk server syncs
            const needsFullRedraw = isFirstLoad || keepScroll || displayedMessages.size === 0 || addedChanges.length > 1;
            const wasAtBottom = (chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight) < 80;

            if (needsFullRedraw) {
                const docs = [];
                snap.forEach(d => docs.push(d));
                docs.reverse(); // Ensure absolute oldest-to-newest order

                // Store scroll height to perfectly maintain position when loading older messages
                const previousScrollHeight = chatBody.scrollHeight;

                chatBody.innerHTML = '';
                displayedMessages.clear();

                let currentDate = '';

                if (docs.length >= chatMessageLimit) {
                    const loader = document.createElement('div');
                    loader.innerHTML = '<small style="color:#0cc0df; cursor:pointer; padding: 10px; display: block;">↑ Load older messages</small>';
                    loader.style.textAlign = 'center';
                    loader.onclick = () => { chatMessageLimit += 50; loadChatMessages(sessionId, true); };
                    chatBody.appendChild(loader);
                }

                docs.forEach(d => {
                    const msg = d.data();
                    let msgDateObj = msg.timestamp ? (msg.timestamp.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp.seconds ? msg.timestamp.seconds * 1000 : msg.timestamp)) : new Date();
                    
                    const msgDate = msgDateObj.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'});
                    const todayStr = new Date().toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'});

                    if (msgDate !== currentDate) {
                        currentDate = msgDate;
                        const datePill = document.createElement('div');
                        datePill.className = 'date-header-pill';
                        datePill.textContent = msgDate === todayStr ? 'Today' : msgDate;
                        chatBody.appendChild(datePill);
                    }

                    appendMessageEl(chatBody, msg, d.id);
                    displayedMessages.add(d.id);

                    if (msg.senderId !== currentUser.uid && msg.status !== 'read' && !attemptedReadUpdates.has(d.id)) {
                        batch.update(doc(db, 'chats', chatId, 'messages', d.id), { status: 'read' });
                        attemptedReadUpdates.add(d.id);
                        hasUnreadUpdates = true;
                    }
                });

                // Maintain scroll integrity
                if (keepScroll) {
                    chatBody.scrollTop = chatBody.scrollHeight - previousScrollHeight;
                } else if (wasAtBottom || isFirstLoad) {
                    chatBody.scrollTop = chatBody.scrollHeight;
                }
                
                isFirstLoad = false;
                keepScroll = false;
            } 
            else {
                // 🚨 FIX: Incremental DOM updates for isolated new messages or read receipts (Stops blinking)
                addedChanges.reverse().forEach(change => {
                    const msg = change.doc.data();
                    
                    let msgDateObj = msg.timestamp ? (msg.timestamp.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp.seconds ? msg.timestamp.seconds * 1000 : msg.timestamp)) : new Date();
                    const msgDate = msgDateObj.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'});
                    const todayStr = new Date().toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'});
                    
                    const existingPills = chatBody.querySelectorAll('.date-header-pill');
                    const lastPill = existingPills.length > 0 ? existingPills[existingPills.length - 1].textContent : '';
                    const expectedPillText = msgDate === todayStr ? 'Today' : msgDate;

                    if (lastPill !== expectedPillText) {
                        const datePill = document.createElement('div');
                        datePill.className = 'date-header-pill';
                        datePill.textContent = expectedPillText;
                        chatBody.appendChild(datePill);
                    }

                    appendMessageEl(chatBody, msg, change.doc.id);
                    displayedMessages.add(change.doc.id);
                    
                    if (msg.senderId !== currentUser.uid && msg.status !== 'read' && !attemptedReadUpdates.has(change.doc.id)) {
                        batch.update(doc(db, 'chats', chatId, 'messages', change.doc.id), { status: 'read' });
                        attemptedReadUpdates.add(change.doc.id);
                        hasUnreadUpdates = true;
                    }
                });

                modifiedChanges.forEach(change => {
                    const msg = change.doc.data();
                    const msgEl = document.querySelector(`[data-message-id="${change.doc.id}"]`);
                    if (msgEl) {
                        if (msg.isDeleted) {
                            const bubble = msgEl.querySelector('.message-bubble');
                            if(bubble) bubble.innerHTML = '<span class="message-deleted">🚫 This message was deleted</span>';
                        } else {
                            const timeEl = msgEl.querySelector('.message-time');
                            if (timeEl && msg.senderId === currentUser.uid) {
                                let ticks = msg.status === 'delivered' || msg.status === 'read' ? '✓✓' : '✓';
                                let color = msg.status === 'read' ? '#34B7F1' : 'inherit';
                                let baseTime = timeEl.innerHTML.split('<span')[0].trim();
                                timeEl.innerHTML = `${baseTime} <span style="color:${color}; letter-spacing:-3px; margin-left:4px; font-weight:bold;">${ticks}</span>`;
                            }
                        }
                    }
                });
                
                if (wasAtBottom) chatBody.scrollTop = chatBody.scrollHeight;
            }

            if (hasUnreadUpdates) batch.commit().catch(err => console.error("Batch update error:", err));

            updateChatTypingIndicator();
            if (currentChatUser) markMessagesAsRead(currentChatUser.uid);
            
        } catch (err) { console.error('Message snapshot error:', err); }
    });

    selfUnsub = unsub;
    messageListeners.push(unsub);
}
function appendMessageEl(container, message, messageId) {
    const typingWrap = container.querySelector('.typing-indicator-container');
    const el = createMessageEl(message, messageId);
    if (typingWrap) container.insertBefore(el, typingWrap);
    else container.appendChild(el);
}

function createMessageEl(message, messageId) {
    const div = document.createElement('div');
    const isMine = message.senderId === currentUser.uid;
    div.className = `message ${isMine ? 'sent' : 'received'}`;
    div.setAttribute('data-message-id', messageId);
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    
    if (message.isDeleted) {
        bubble.innerHTML = '<span class="message-deleted">🚫 This message was deleted</span>';
    } else {
        // ✅ NEW: Video rendering logic with inline streaming player
        if (message.videoUrl) {
            bubble.innerHTML = `
                <video controls preload="metadata" style="max-width: 100%; border-radius: 12px; margin-bottom: 5px; outline: none; background: #000; box-shadow: 0 1px 3px rgba(0,0,0,0.2);">
                    <source src="${message.videoUrl}" type="video/mp4">
                    Your browser does not support the video tag.
                </video>`;
            if (message.senderId === currentUser.uid) bubble.style.padding = '4px';
            
            if (message.text && message.text !== '🎥 Video') {
                const txt = document.createElement('div');
                txt.style.padding = '8px';
                txt.textContent = message.text;
                bubble.appendChild(txt);
            }
        } 
        // Existing image logic
        else if (message.imageUrl) {
            bubble.innerHTML = `<img src="${message.imageUrl}" class="message-image" loading="lazy" onclick="openImageViewer('${message.imageUrl}', '${messageId}')">`;
            if (message.senderId === currentUser.uid) bubble.style.padding = '0';
            
            if (message.text && message.text !== '📷 Photo') {
                const txt = document.createElement('div');
                txt.style.padding = '8px';
                txt.textContent = message.text;
                bubble.appendChild(txt);
            }
        } else if (message.isHtml) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = message.text || '';
            bubble.appendChild(tempDiv);
        } else {
            bubble.appendChild(document.createTextNode(message.text || ''));
        }
        
        // Context menu logic remains the same...
        if (isMine) {
            bubble.oncontextmenu = (e) => {
                e.preventDefault();
                if (confirm('Delete this message for everyone?')) deleteMessage(messageId);
            };
            let pressTimer;
            bubble.addEventListener('touchstart', () => { pressTimer = setTimeout(() => { if (confirm('Delete this message for everyone?')) deleteMessage(messageId); }, 800); });
            bubble.addEventListener('touchend', () => clearTimeout(pressTimer));
            bubble.addEventListener('touchmove', () => clearTimeout(pressTimer));
        }
    }

    // ✅ FIX: Bulletproof timestamp check for time rendering
    let t = new Date();
    if (message.timestamp) {
        if (message.timestamp.toDate) t = message.timestamp.toDate();
        else if (message.timestamp.seconds) t = new Date(message.timestamp.seconds * 1000);
        else t = new Date(message.timestamp);
    }
    
    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    let timeText = t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    if (isMine && !message.isDeleted) {
        let ticks = '✓'; 
        let color = 'inherit';
        if (message.status === 'delivered') ticks = '✓✓';
        if (message.status === 'read') { ticks = '✓✓'; color = '#34B7F1'; } 
        timeText += ` <span style="color:${color}; letter-spacing:-3px; margin-left:4px; font-weight:bold;">${ticks}</span>`;
    }
    
    timeEl.innerHTML = timeText;
    bubble.appendChild(timeEl);
    
    div.appendChild(bubble);
    return div;
}

// ✅ NEW: Delete Message Logic
async function deleteMessage(messageId) {
    if (!currentChatUser) return;
    try {
        const chatId = makeChatId(currentChatUser.uid);

        // Update the specific message
        await updateDoc(doc(db, 'chats', chatId, 'messages', messageId), {
            isDeleted: true, text: '🚫 This message was deleted', imageUrl: null, videoUrl: null
        });

        // Update the parent chat document so the sidebar preview updates globally
        await setDoc(doc(db, 'chats', chatId), {
            lastMessage: '🚫 This message was deleted'
        }, { merge: true });

    } catch(err) { alert("Could not delete message."); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPING INDICATOR — zero DOM thrashing
// ═══════════════════════════════════════════════════════════════════════════════
function updateChatTypingIndicator() {
    if (!currentChatUser) return;
    const chatBody = document.getElementById('chatMessages');
    if (!chatBody) return;
    const isTyping = typingUsers.get(currentChatUser.uid) || false;
    const existing = chatBody.querySelector('.typing-indicator-container');
    if (isTyping && !existing) {
        const wasAtBottom = (chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight) < 80;
        const wrap = document.createElement('div');
        wrap.className = 'message received typing-indicator-container';
        wrap.innerHTML = `
            <div class="typing-indicator">
                <div class="typing-text">${currentChatUser.displayName} is typing</div>
                <div class="typing-dots">
                    <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
                </div>
            </div>`;
        chatBody.appendChild(wrap);
        if (wasAtBottom) chatBody.scrollTop = chatBody.scrollHeight;
    } else if (!isTyping && existing) {
        existing.remove();
    }
}

function updateChatHeaderStatus() {
    if (!currentChatUser) return;
    const el = document.getElementById('chatUserStatus');
    if (!el) return;
    const isTyping = typingUsers.get(currentChatUser.uid) || false;
    const isOnline = onlineUsers.has(currentChatUser.uid);
    if (isTyping)      { el.textContent = 'typing...';          el.className = 'chat-user-status typing'; }
    else if (isOnline) { el.textContent = 'online';             el.className = 'chat-user-status online'; }
    else               { el.textContent = 'last seen recently'; el.className = 'chat-user-status'; }
    const avatarEl = document.getElementById('chatUserAvatar');
    if (avatarEl) {
        const dot = avatarEl.querySelector('.online-status, .offline-status');
        if (dot) dot.className = isOnline ? 'online-status' : 'offline-status';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEND MESSAGE
// ═══════════════════════════════════════════════════════════════════════════════
async function sendMessage() {
    try {
        const inp = document.getElementById('messageInput');
        const btn = document.getElementById('sendButton');
        if (!inp || !btn || !currentChatUser) return;
        
        const text = inp.value.trim();
        if (!text) return;

        // ✅ FIX 1: Clear the input box INSTANTLY before waiting for the network
        inp.value = '';
        inp.style.height = 'auto';
        resetTypingStatus();
        // btn.disabled = true; // Removed: disabling button causes keyboard to close on mobile

        const chatId = makeChatId(currentChatUser.uid);
        
        const userSnap   = await getDoc(doc(db, 'users', currentUser.uid));
        const userData   = userSnap.exists() ? userSnap.data() : {};
        const senderName = userData?.displayName || userData?.customName || userData?.name || localStorage.getItem('userName') || 'User'; // ✅ FIX B: displayName checked first

        const msgData = {
            text, senderId: currentUser.uid, senderName,
            timestamp: serverTimestamp(), chatId, recipientId: currentChatUser.uid,
            status: 'sent' 
        };

        const messagesRef = collection(db, 'chats', chatId, 'messages');
        const newDocRef = doc(messagesRef); 
        
        const fakeMsg = { ...msgData, timestamp: new Date() };
        appendMessageEl(document.getElementById('chatMessages'), fakeMsg, newDocRef.id);
        displayedMessages.add(newDocRef.id);
        
        const chatBody = document.getElementById('chatMessages');
        if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;

        await setDoc(newDocRef, msgData);
        await setDoc(doc(db, 'chats', chatId), {
            id: chatId, members: [currentUser.uid, currentChatUser.uid],
            lastMessage: text, lastMessageSender: currentUser.uid, lastTimestamp: serverTimestamp()
        }, { merge: true });

        lastMessages.set(currentChatUser.uid, fakeMsg);
        renderUserList();
        const myItem = document.querySelector(`#usersList [data-uid="${currentChatUser.uid}"]`);
        if (myItem) myItem.classList.add('active');

        setTimeout(() => inp.focus(), 50);
    } catch (err) {
        console.error('❌ Send message error:', err);
    } finally {
        // if (btn) btn.disabled = false; // Removed: disabling button causes keyboard to close on mobile
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPING — debounced, 1 write per session start
// ═══════════════════════════════════════════════════════════════════════════════
function attachTypingListener() {
    const inp = document.getElementById('messageInput');
    if (!inp || !currentChatUser) return;
    detachTypingListener();
    typingInputListener = () => {
        const chatId = makeChatId(currentChatUser.uid);
        if (!isTypingCurrently) {
            isTypingCurrently = true;
            setDoc(doc(db, 'typing', chatId), {
                [currentUser.uid]: { typing: true, timestamp: serverTimestamp(), userName: localStorage.getItem('userName') || 'User' }
            }, { merge: true }).catch(() => {});
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            isTypingCurrently = false;
            setDoc(doc(db, 'typing', chatId), {
                [currentUser.uid]: { typing: false, timestamp: serverTimestamp(), userName: localStorage.getItem('userName') || 'User' }
            }, { merge: true }).catch(() => {});
        }, 1500);
    };
    inp.addEventListener('input', typingInputListener);
}

function detachTypingListener() {
    const inp = document.getElementById('messageInput');
    if (inp && typingInputListener) inp.removeEventListener('input', typingInputListener);
    typingInputListener = null;
    isTypingCurrently   = false;
    clearTimeout(typingTimeout);
}

function resetTypingStatus() {
    if (!currentChatUser) return;
    setDoc(doc(db, 'typing', makeChatId(currentChatUser.uid)), {
        [currentUser.uid]: { typing: false, timestamp: serverTimestamp() }
    }, { merge: true }).catch(() => {});
    isTypingCurrently = false;
    clearTimeout(typingTimeout);
}

function attachIncomingTypingListener(chatUserId) {
    if (currentTypingUnsubscribe) { try { currentTypingUnsubscribe(); } catch (_) {} currentTypingUnsubscribe = null; }
    if (!chatUserId) return;
    currentTypingUnsubscribe = onSnapshot(doc(db, 'typing', makeChatId(chatUserId)), snap => {
        try {
            const data = snap.data() || {};
            typingUsers.set(chatUserId, !!(data[chatUserId]?.typing === true));
            updateChatHeaderStatus();
            updateChatTypingIndicator();
        } catch (_) {}
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK READ
// ═══════════════════════════════════════════════════════════════════════════════
async function markMessagesAsRead(userId) {
    try {
        const chatId = makeChatId(userId);
        unreadCounts.set(userId, 0);
        updatePreviewForUser(userId);
        await setDoc(doc(db, 'lastRead', `${chatId}_${currentUser.uid}`), {
            timestamp: serverTimestamp(), chatId, userId: currentUser.uid
        }, { merge: true });
    } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSE CHAT
// ═══════════════════════════════════════════════════════════════════════════════
function closeChatWindow() {
    try {
        chatSessionId++; // invalidate any in-flight listeners
        resetTypingStatus();
        detachTypingListener();
        if (currentTypingUnsubscribe) { try { currentTypingUnsubscribe(); } catch (_) {} currentTypingUnsubscribe = null; }
        messageListeners.forEach(u => { try { u(); } catch (_) {} });
        messageListeners = [];
        displayedMessages.clear();
        document.getElementById('chatModal').style.display = 'none';
        document.getElementById('emojiPicker')?.classList.remove('show');
        const prev = currentChatUser;
        currentChatUser = null;
        if (prev) {
            const item = document.querySelector(`#usersList [data-uid="${prev.uid}"]`);
            if (item) item.classList.remove('active');
        }
    } catch (err) {
        console.warn('⚠️ Close chat error:', err);
    }
}

function openSettings() {
    const el = document.getElementById('currentUserName');
    if (el) localStorage.setItem('userName', el.textContent);
    window.location.href = 'page3.html';
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════════
function setupEventListeners() {
    document.getElementById('usersSearchInput')?.addEventListener('input', filterUsers);
    const inp = document.getElementById('messageInput');
    if (inp) {
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
    }
    const modal = document.getElementById('chatModal');
    modal?.addEventListener('click', e => { if (e.target === modal) closeChatWindow(); });
    const emojiBtn = document.getElementById('emojiButton');
    const emojiPkr = document.getElementById('emojiPicker');
    emojiBtn?.addEventListener('click', e => { e.stopPropagation(); emojiPkr?.classList.toggle('show'); });
    document.addEventListener('click', e => {
        if (emojiPkr && emojiBtn && !emojiPkr.contains(e.target) && !emojiBtn.contains(e.target)) {
            emojiPkr.classList.remove('show');
        }
    });
}

function setupAutoResize(textarea) {
    if (!textarea) return;
    const resize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'; };
    textarea.addEventListener('input', resize);
    resize();
}

// ✅ FIX: Force instantaneous offline write before the browser kills the tab
window.addEventListener('beforeunload', () => {
    if (currentUser) {
        set(ref(rtdb, `presence/${currentUser.uid}`), {
            state: 'offline',
            last_changed: rtdbServerTimestamp(),
            userId: currentUser.uid
        }).catch(() => {});
    }

    chatSessionId++;
    messageListeners.forEach(u => { try { u(); } catch (_) {} });
    globalMessageListeners.forEach(u => { try { u(); } catch (_) {} });
    typingListeners.forEach(u => { try { u(); } catch (_) {} });
    if (presenceUpdateTimer) clearInterval(presenceUpdateTimer);
    if (typingTimeout) clearTimeout(typingTimeout);
});

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('uploadBtn')?.addEventListener('click', () => { window.location.href = 'index.html'; });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════
function makeChatId(otherUid) {
    return [currentUser.uid, otherUid].sort().join('_');
}
function setAvatarContent(el, displayName, photoURL) {
    if (photoURL) {
        const img = document.createElement('img');
        img.src = photoURL; img.alt = displayName;
        img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
        el.innerHTML = ''; el.appendChild(img);
    } else {
        el.textContent = (displayName || 'U').charAt(0).toUpperCase();
    }
}
function getTimeAgo(timestamp) {
    try {
        if (!timestamp) return '';
        let t;
        if (typeof timestamp.toDate === 'function') t = timestamp.toDate();
        else if (timestamp instanceof Date) t = timestamp;
        else if (typeof timestamp === 'number') t = new Date(timestamp);
        else if (timestamp?.seconds) t = new Date(timestamp.seconds * 1000);
        else return '';
        const s = Math.floor((Date.now() - t.getTime()) / 1000);
        if (s < 60)     return 'now';
        if (s < 3600)   return `${Math.floor(s / 60)}m`;
        if (s < 86400)  return `${Math.floor(s / 3600)}h`;
        if (s < 604800) return `${Math.floor(s / 86400)}d`;
        return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
}

// ==================== VOICE CALLING ====================

const rtcConfiguration = {
    iceServers: [
        { urls: 'stun:stun.relay.metered.ca:80' },
        {
            urls: 'turn:global.relay.metered.ca:80',
            username: '97279be94f4a28b5ea2f7af3',
            credential: '8CWw5PD2fuEEae7u'
        },
        {
            urls: 'turn:global.relay.metered.ca:80?transport=tcp',
            username: '97279be94f4a28b5ea2f7af3',
            credential: '8CWw5PD2fuEEae7u'
        },
        {
            urls: 'turn:global.relay.metered.ca:443',
            username: '97279be94f4a28b5ea2f7af3',
            credential: '8CWw5PD2fuEEae7u'
        },
        {
            urls: 'turns:global.relay.metered.ca:443?transport=tcp',
            username: '97279be94f4a28b5ea2f7af3',
            credential: '8CWw5PD2fuEEae7u'
        }
    ],
    iceCandidatePoolSize: 10, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require'
};

async function registerForPushNotifications() {
    try {
        if (!('Notification' in window)) { await switchToEmailNotifications(); return null; }
        
        // ✅ FIX 2: Check database BEFORE asking for push permission. 
        // If they chose email, stop right here so we don't overwrite it!
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        if (userDoc.exists() && userDoc.data().notificationPreference === 'email') {
            return null; 
        }

        if (Notification.permission === 'denied') { await switchToEmailNotifications(); return null; }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') { await switchToEmailNotifications(); return null; }
        if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/firebase-messaging-sw.js');
        const vapidKey = 'BJE_dJUBFv0WB__XgB-UnZIAM75Zz3eVx_-slupOSQmj7_REPMEor8qmKdk7ijQIVwsXmYxcmphX9XntlCZvHZ8';
        const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: await navigator.serviceWorker.ready });
        
        if (token) {
            // ✅ FIX 2.5: Removed the hardcoded notificationPreference: 'push' overwrite
            await updateDoc(doc(db, 'users', currentUser.uid), { fcmToken: token, email: currentUser.email });
            return token;
        }
    } catch (_) { await switchToEmailNotifications(); return null; }
}
async function switchToEmailNotifications() {
    try { await updateDoc(doc(db, 'users', currentUser.uid), { notificationPreference: 'email', email: currentUser.email, fcmToken: null }); } catch (_) {}
}

onMessage(messaging, payload => {
    const data = payload.data || {};
    if (data.callId) showIncomingCallNotification(data);
});

function showIncomingCallNotification(data) {
    activeCallId = data.callId;
    const m = document.getElementById('callModal'); if (m) m.style.display = 'block';
    const cs = document.getElementById('callStatus'); if (cs) cs.textContent = '📞 Incoming Call';
    const cu = document.getElementById('callUserName'); if (cu) cu.textContent = data.callerName || 'Unknown';
    const ib = document.getElementById('incomingCallButtons'); if (ib) ib.style.display = 'flex';
    const eb = document.getElementById('endCallButton'); if (eb) eb.style.display = 'none';
    const ct = document.getElementById('callTimer'); if (ct) ct.style.display = 'none';
    document.getElementById('ringtone')?.play().catch(() => {});
}

async function initiateCall() {
    if (!currentChatUser) { alert('Please select a user to call'); return; }
    try {
        activeCallId   = `call_${currentUser.uid}_${currentChatUser.uid}_${Date.now()}`;
        const callRef  = doc(db, 'calls', activeCallId);
        peerConnection = new RTCPeerConnection(rtcConfiguration);
        try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
        catch (_) { alert('🎤 Microphone permission denied!'); activeCallId = null; if (peerConnection) { peerConnection.close(); peerConnection = null; } return; }
        localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
        peerConnection.ontrack = e => { const ra = document.getElementById('remoteAudio'); if (ra && ra.srcObject !== e.streams[0]) { ra.srcObject = e.streams[0]; remoteStream = e.streams[0]; } };
        peerConnection.oniceconnectionstatechange = () => { if (peerConnection.iceConnectionState === 'failed') peerConnection.restartIce(); };
        peerConnection.onconnectionstatechange = () => { if (peerConnection.connectionState === 'connected') updateCallStatus('Connected', true); else if (peerConnection.connectionState === 'failed') alert('Connection failed.'); };
        const offer = await peerConnection.createOffer();

        // 🚨 FIX 1: Create the Firestore document BEFORE setting local description.
        // Setting local description triggers onicecandidate immediately — if the doc
        // doesn't exist yet, every updateDoc call fails and candidates are lost forever.
        await setDoc(callRef, { callId: activeCallId, callerId: currentUser.uid, calleeId: currentChatUser.uid, status: 'ringing', offer: { type: offer.type, sdp: offer.sdp }, iceCandidates: {}, createdAt: serverTimestamp() });

        // 🚨 FIX 2: Now it's safe to trigger ICE gathering — the doc exists.
        await peerConnection.setLocalDescription(offer);

        peerConnection.onicecandidate = async e => { if (!e.candidate) return; try { await updateDoc(callRef, { [`iceCandidates.${currentUser.uid}`]: arrayUnion(JSON.stringify(e.candidate.toJSON())) }); } catch (err) { console.error("ICE Save Error:", err); } };
        showCallUI('Calling...', currentChatUser.displayName || currentChatUser.email);
        listenForCallUpdates(callRef);
        await notifyCallee(currentChatUser.uid, activeCallId);

        // ✅ FIX: Auto-expire call and log missed call if totally unanswered after 60 seconds
        setTimeout(async () => {
            if (activeCallId) {
                try {
                    const callDoc = await getDoc(doc(db, 'calls', activeCallId));
                    if (callDoc.exists() && callDoc.data().status === 'ringing') {
                        await updateDoc(doc(db, 'calls', activeCallId), { status: 'expired' });
                        await sendCallLogMessage(currentChatUser.uid, "📞 Missed voice call");
                        endCall(true);
                    }
                } catch (_) {}
            }
        }, 60000);

    } catch (err) { console.error('❌ Error initiating call:', err); alert('Failed to initiate call.'); endCall(true); }
}
window.initiateCall = initiateCall;

function listenForCallUpdates(callRef) {
    callUnsubscribe = onSnapshot(callRef, async snap => {
        const data = snap.data(); if (!data) return;

        // 1. INDEPENDENT BLOCK: Process the answer if we are the Caller.
        // Uses its own if — NOT else if — so the ICE block below always runs too.
        if (data.status === 'accepted' && data.answer && peerConnection && !peerConnection.currentRemoteDescription) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            updateCallStatus('Connected ✓', true);
        }

        // 2. INDEPENDENT BLOCK: Add incoming ICE candidates from the other peer.
        // Decoupled from block 1 so candidates are never skipped when both arrive
        // in the same Firestore snapshot.
        if (data.status === 'accepted' && peerConnection && peerConnection.currentRemoteDescription) {
            const other = data.callerId === currentUser.uid ? data.calleeId : data.callerId;
            const newCandidates = data.iceCandidates?.[other] || [];
            if (!peerConnection._addedCandidates) peerConnection._addedCandidates = new Set();
            for (const c of newCandidates) {
                const cs = typeof c === 'string' ? c : JSON.stringify(c);
                if (!peerConnection._addedCandidates.has(cs)) {
                    try { await peerConnection.addIceCandidate(new RTCIceCandidate(JSON.parse(cs))); peerConnection._addedCandidates.add(cs); }
                    catch (err) { console.error("Failed to add ICE candidate", err); }
                }
            }
        }

        // 3. Handle call endings.
        if (['rejected','ended','expired'].includes(data.status)) { endCall(true); }
    });
}

// ✅ FIX: Verify the call is still ringing before connecting
async function acceptIncomingCall() {
    if (!activeCallId) return;
    try {
        const callRef = doc(db, 'calls', activeCallId);
        const callData = (await getDoc(callRef)).data();
        
        if (!callData) { alert('Call not found'); endCall(); return; }
        
        // 🚨 CRITICAL FIX: Block accepting if caller already hung up
        if (callData.status !== 'ringing') {
            alert('Call has already ended or was missed.');
            endCall(true);
            return;
        }

        const callerDoc = await getDoc(doc(db, 'users', callData.callerId));
        const cData = callerDoc.exists() ? callerDoc.data() : {};
        const callerName = cData.displayName || cData.customName || cData.name || 'User';

        peerConnection = new RTCPeerConnection(rtcConfiguration);
        try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
        catch (_) { alert('🎤 Microphone permission denied!'); declineCall(); return; }
        
        localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
        peerConnection.ontrack = e => { const ra = document.getElementById('remoteAudio'); if (ra && ra.srcObject !== e.streams[0]) { ra.srcObject = e.streams[0]; remoteStream = e.streams[0]; } };
        peerConnection.oniceconnectionstatechange = () => { if (peerConnection.iceConnectionState === 'failed') peerConnection.restartIce(); };
        peerConnection.onconnectionstatechange = () => { if (peerConnection.connectionState === 'connected') updateCallStatus('Connected', true); };
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(callData.offer));
        if (!peerConnection._addedCandidates) peerConnection._addedCandidates = new Set();
        for (const c of (callData.iceCandidates?.[callData.callerId] || [])) { try { await peerConnection.addIceCandidate(new RTCIceCandidate(JSON.parse(c))); } catch (_) {} }
        
        const answer = await peerConnection.createAnswer();

        // 🚨 FIX: Save the answer to Firestore BEFORE setLocalDescription.
        // setLocalDescription triggers callee's onicecandidate immediately — the doc
        // must already have the answer written so candidates land in the right state.
        await updateDoc(callRef, { status: 'accepted', answer: { type: answer.type, sdp: answer.sdp } });

        // 🚨 FIX: Now safe to trigger callee ICE gathering.
        await peerConnection.setLocalDescription(answer);

        peerConnection.onicecandidate = async e => { if (!e.candidate) return; try { await updateDoc(callRef, { [`iceCandidates.${currentUser.uid}`]: arrayUnion(JSON.stringify(e.candidate.toJSON())) }); } catch (_) {} };

        const ringtone = document.getElementById('ringtone'); if (ringtone) { ringtone.pause(); ringtone.currentTime = 0; }
        const ib = document.getElementById('incomingCallButtons'); if (ib) ib.style.display = 'none';

        showCallUI('Connected', callerName);
        updateCallStatus('Connected ✓', true);
        listenForCallUpdates(callRef);
    } catch (err) { console.error('❌ Error accepting call:', err); endCall(); }
}
window.acceptIncomingCall = acceptIncomingCall;

async function declineCall() {
    if (activeCallId) { 
        try { 
            const callDoc = await getDoc(doc(db, 'calls', activeCallId));
            if(callDoc.exists()) {
                const data = callDoc.data();
                await updateDoc(doc(db, 'calls', activeCallId), { status: 'rejected' }); 
                // ✅ FIX: Callee logs the missed call when rejecting
                await sendCallLogMessage(data.callerId, "📞 Missed voice call");
            }
        } catch (_) {} 
    }
    endCall(true); // true to skip duplicate logging in endCall
}
window.declineCall = declineCall;

async function endCall(skipLog = false) {
    // ✅ FIX: Determine if we need to log a message before destroying the activeCallId
    let logMsg = "";
    let otherUser = null;

    if (activeCallId && !skipLog) {
        try { 
            const callDoc = await getDoc(doc(db, 'calls', activeCallId));
            if (callDoc.exists()) {
                const data = callDoc.data();
                const isCaller = data.callerId === currentUser.uid;
                otherUser = isCaller ? data.calleeId : data.callerId;
                
                if (data.status === 'ringing' && isCaller) {
                    logMsg = "📞 Missed voice call";
                } else if (data.status === 'accepted' || data.status === 'connected') {
                    logMsg = "📞 Voice call ended";
                }
                await updateDoc(doc(db, 'calls', activeCallId), { status: 'ended' }); 
            }
        } catch (_) {} 
    }

    const ringtone = document.getElementById('ringtone'); if (ringtone) { ringtone.pause(); ringtone.currentTime = 0; }
    if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
    if (localStream) { localStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} }); localStream = null; }
    if (peerConnection) { try { peerConnection.close(); } catch (_) {} peerConnection = null; }
    if (callUnsubscribe) { try { callUnsubscribe(); } catch (_) {} callUnsubscribe = null; }
    const cm = document.getElementById('callModal'); if (cm) cm.style.display = 'none';
    isSpeakerOn = false;
    const sb = document.getElementById('speakerToggleBtn'); if (sb) { sb.style.display = 'none'; sb.textContent = '🔈 Earpiece'; sb.style.background = 'rgba(255,255,255,0.15)'; }
    const ct = document.getElementById('callTimer'); if (ct) { ct.textContent = '00:00'; ct.style.display = 'none'; }
    
    activeCallId = null;

    // Fire the log into the chat DB
    if (logMsg && otherUser) {
        sendCallLogMessage(otherUser, logMsg);
    }
}
window.endCall = endCall;

function showCallUI(status, userName) {
    const m = document.getElementById('callModal'); if (m) m.style.display = 'block';
    const cs = document.getElementById('callStatus'); if (cs) cs.textContent = status;
    const cu = document.getElementById('callUserName'); if (cu) cu.textContent = userName;
    const ib = document.getElementById('incomingCallButtons'); if (ib) ib.style.display = 'none';
    const eb = document.getElementById('endCallButton'); if (eb) eb.style.display = 'block';
}
function updateCallStatus(status, showTimer = false) {
    const cs = document.getElementById('callStatus'); if (cs) cs.textContent = status;
    const eb = document.getElementById('endCallButton'); if (eb) eb.style.display = 'block';
    const ib = document.getElementById('incomingCallButtons'); if (ib) ib.style.display = 'none';
    if (showTimer) {
        const ct = document.getElementById('callTimer'); if (ct) ct.style.display = 'block';
        startCallTimer();
        const sb = document.getElementById('speakerToggleBtn'); if (sb) sb.style.display = 'inline-block';
    }
}
async function toggleSpeaker() {
    isSpeakerOn = !isSpeakerOn;
    const ra = document.getElementById('remoteAudio'), btn = document.getElementById('speakerToggleBtn');
    if (!ra || !btn) return;
    if ('setSinkId' in ra) {
        try {
            if (isSpeakerOn) { await ra.setSinkId(''); btn.textContent = '🔊 Speaker On'; btn.style.background = 'rgba(37,211,102,0.3)'; }
            else {
                const devs = await navigator.mediaDevices.enumerateDevices();
                const ep = devs.find(d => d.kind === 'audiooutput' && (d.label.toLowerCase().includes('earpiece') || d.label.toLowerCase().includes('phone')));
                await ra.setSinkId(ep ? ep.deviceId : 'default');
                btn.textContent = '🔈 Earpiece'; btn.style.background = 'rgba(255,255,255,0.15)';
            }
        } catch (_) { btn.textContent = isSpeakerOn ? '🔊 Speaker' : '🔈 Earpiece'; }
    } else { btn.textContent = isSpeakerOn ? '🔊 Speaker' : '🔈 Earpiece'; }
}
window.toggleSpeaker = toggleSpeaker;

function startCallTimer() {
    callStartTime = Date.now();
    const el = document.getElementById('callTimer');
    callTimerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - callStartTime) / 1000);
        if (el) el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    }, 1000);
}

// ✅ FIX: Automatically decide between In-App Push or Offline Email based on RTDB Presence
async function notifyCallee(calleeId, callId) {
    try {
        // 1. Check if the user is currently online anywhere on your site
        const presenceSnap = await get(ref(rtdb, `presence/${calleeId}`));
        const presenceData = presenceSnap.exists() ? presenceSnap.val() : null;
        const isOnline = presenceData && presenceData.state === 'online';

        // 2. ONLY send an email if their browser is closed (offline)
        if (!isOnline) {
            const d = (await getDoc(doc(db, 'users', calleeId))).data();
            if (d && d.email) {
                const myName = localStorage.getItem('userName') || currentUser.displayName || currentUser.email?.split('@')[0] || 'Someone';
                await sendEmailNotification(d.email, myName, callId);
                console.log('✅ User is offline. Automatic email notification sent.');
            }
        } else {
            console.log('✅ User is online. In-app global banner will handle the notification.');
        }
    } catch (err) {
        console.error('❌ Error notifying callee:', err);
    }
}
async function sendEmailNotification(email, callerName, callId) {
    try {
        // ✅ FIX: Send as URLSearchParams (Standard Form Data). 
        // Google Apps Script accepts this natively without crashing.
        const params = new URLSearchParams();
        params.append('secret', EMAIL_SECRET);
        params.append('to', email);
        params.append('subject', `Incoming call from ${callerName}`);
        params.append('callerName', callerName);
        params.append('callId', callId);
        params.append('appUrl', window.location.origin);

        await fetch(EMAIL_FALLBACK_URL, { 
            method: 'POST', 
            mode: 'no-cors',
            body: params 
        });
        
        console.log('✅ Email trigger sent via standard Form Data');
    } catch (err) {
        console.error('❌ Email fetch error:', err);
    }
}

function handleCallFromURL() {
    const p = new URLSearchParams(window.location.search);
    const callId = p.get('callId'), action = p.get('action');
    if (!callId) return;
    activeCallId = callId;
    if (action === 'accept') acceptIncomingCall();
    else showIncomingCallFromFirestore(callId);
    window.history.replaceState({}, document.title, window.location.pathname);
}
// ✅ FIX: Relaxed time limits to 120 seconds to prevent auto-drops due to device clock drift
async function showIncomingCallFromFirestore(callId) {
    try {
        const callData = (await getDoc(doc(db, 'calls', callId))).data();
        if (!callData || callData.status !== 'ringing') return;
        
        // Changed 60000 to 120000 (2 mins) to tolerate clock skew
        if (Date.now() - (callData.createdAt?.toMillis?.() || Date.now()) > 120000) { try { await updateDoc(doc(db, 'calls', callId), { status: 'expired' }); } catch (_) {} return; }
        const cdSnap = await getDoc(doc(db, 'users', callData.callerId));
        const cd = cdSnap.data() || {};
        const cName = cd.displayName || cd.customName || cd.name || cd.email?.split('@')[0] || 'Unknown';
        showIncomingCallNotification({ callId, callerName: cName, callerId: callData.callerId });
    } catch (_) {}
}
function listenForIncomingCalls() {
    if (!currentUser) return;
    onSnapshot(
        query(collection(db, 'calls'), where('calleeId', '==', currentUser.uid), where('status', '==', 'ringing')),
        snap => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added' && change.type !== 'modified') return;
                const d = change.doc.data();
                
                // Changed 60000 to 120000 (2 mins) to tolerate clock skew
                if (Date.now() - (d.createdAt?.toMillis?.() || Date.now()) > 120000) { updateDoc(doc(db, 'calls', d.callId), { status: 'expired' }).catch(() => {}); return; }
                activeCallId = d.callId;
                getDoc(doc(db, 'users', d.callerId))
                    .then(cd => { 
                        const data = cd.data() || {}; 
                        const cName = data.displayName || data.customName || data.name || data.email?.split('@')[0] || 'Unknown';
                        showIncomingCallNotification({ callId: d.callId, callerName: cName, callerId: d.callerId }); 
                    })
                    .catch(() => showIncomingCallNotification({ callId: d.callId, callerName: 'Unknown', callerId: d.callerId }));
            });
        },
        err => console.error('❌ Call listener error:', err)
    );
}
window.cleanupOldCalls = async function () {
    try {
        const snap = await getDocs(query(collection(db, 'calls'), where('status', '==', 'ringing'))); let n = 0;
        for (const d of snap.docs) { if (Date.now() - (d.data().createdAt?.toMillis?.() || Date.now()) > 60000) { await updateDoc(doc(db, 'calls', d.id), { status: 'expired' }); n++; } }
        alert(`Cleanup complete! Removed ${n} old call(s)`);
    } catch (err) { alert('Cleanup failed: ' + err.message); }
};

// ✅ FIX: Inject WhatsApp-style call logs directly into the chat history
async function sendCallLogMessage(otherUserId, text) {
    try {
        const chatId = makeChatId(otherUserId);
        const msgData = {
            text, senderId: currentUser.uid, senderName: currentUser.displayName || localStorage.getItem('userName') || 'User', // ✅ FIX B
            timestamp: serverTimestamp(), chatId, recipientId: otherUserId
        };
        const newDocRef = doc(collection(db, 'chats', chatId, 'messages'));
        
        // Instantly show it in the UI if the chat is currently open
        if (currentChatUser && currentChatUser.uid === otherUserId) {
            const chatBody = document.getElementById('chatMessages');
            // Safety check: chatBody may be null if user navigated away or chat modal isn't rendered
            if (chatBody) {
                const fakeMsg = { ...msgData, timestamp: new Date() };
                appendMessageEl(chatBody, fakeMsg, newDocRef.id);
                displayedMessages.add(newDocRef.id);
                chatBody.scrollTop = chatBody.scrollHeight;
            }
        }
        
        await setDoc(newDocRef, msgData);
        await setDoc(doc(db, 'chats', chatId), {
            id: chatId, members: [currentUser.uid, otherUserId],
            lastMessage: text, lastMessageSender: currentUser.uid, lastTimestamp: serverTimestamp()
        }, { merge: true });
        
        lastMessages.set(otherUserId, msgData);
        renderUserList();
    } catch (err) { console.error('Error logging call:', err); }
}

// ✅ NEW: Unified Media Sender (Photos to ImgBB, Videos to Cloudinary)
async function sendMediaMessage(event) {
    const file = event.target.files[0];
    if (!file || !currentChatUser) return;
    
    const isVideo = file.type.startsWith('video/');
    const chatId = makeChatId(currentChatUser.uid);
    const msgId = 'temp_' + Date.now();
    
    // Optimistic UI update with dynamic text
    const loadingText = isVideo ? 'Uploading Video...' : 'Uploading Photo...';
    const fakeMsg = { text: `<div class="bubble-loader"></div><div style="text-align:center; font-size:0.8rem; color: #888;">${loadingText}</div>`, senderId: currentUser.uid, timestamp: new Date(), status: 'sending', isHtml: true };
    appendMessageEl(document.getElementById('chatMessages'), fakeMsg, msgId);
    document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
    
    try {
        let msgData = {
            senderId: currentUser.uid, 
            senderName: currentUser.displayName || localStorage.getItem('userName') || 'User', // ✅ FIX B
            timestamp: serverTimestamp(), 
            chatId, recipientId: currentChatUser.uid, status: 'sent'
        };

        if (isVideo) {
            // 🎥 CLOUDINARY VIDEO UPLOAD
            const CLOUDINARY_URL = 'https://api.cloudinary.com/v1_1/dqbf4ccxz/video/upload';
            const UPLOAD_PRESET = 'shutter-soul'; // 🚨 REPLACE THIS WITH YOUR PRESET NAME FROM STEP 1
            
            const formData = new FormData();
            formData.append('file', file);
            formData.append('upload_preset', UPLOAD_PRESET);

            const response = await fetch(CLOUDINARY_URL, { method: 'POST', body: formData });
            const data = await response.json();
            
            if (data.secure_url) {
                msgData.text = '🎥 Video';
                // Optimize Cloudinary URL for faster streaming (q_auto, f_auto)
                const optimizedUrl = data.secure_url.replace('/upload/', '/upload/q_auto,f_auto/');
                msgData.videoUrl = optimizedUrl;
            } else { throw new Error("Video upload failed"); }

        } else {
            // 📷 IMGBB PHOTO UPLOAD (Existing logic)
            const IMGBB_API_KEY = 'dc7cfbde88ec48894781740d1d8ff64d'; 
            const formData = new FormData();
            formData.append('image', file);
            
            const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
            const data = await response.json();
            
            if (data.success) {
                msgData.text = '📷 Photo';
                msgData.imageUrl = data.data.url;
            } else { throw new Error("Image upload failed"); }
        }
        
        await addDoc(collection(db, 'chats', chatId, 'messages'), msgData);
        await setDoc(doc(db, 'chats', chatId), {
            id: chatId, members: [currentUser.uid, currentChatUser.uid],
            lastMessage: msgData.text, lastMessageSender: currentUser.uid, lastTimestamp: serverTimestamp()
        }, { merge: true });

    } catch (err) { 
        console.error(err);
        alert("Media upload failed"); 
    }
    
    const tempEl = document.querySelector(`[data-message-id="${msgId}"]`);
    if (tempEl) tempEl.remove();
    event.target.value = ''; 
}
window.sendMediaMessage = sendMediaMessage;
window.sendImageMessage = sendMediaMessage; // Fallback to prevent breaking old html binds

// ==============================================================================
// ✅ ENHANCED IMAGE VIEWER (Blurred Background, Download, Share, Info)
// ==============================================================================

// Track currently viewed image details to enable action buttons
let currentViewedImageUrl = '';
let currentViewedMessageId = '';

// Inject the structure into the page (with a blur overlay and 3 buttons)
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('imageViewerModal')) return; // Avoid duplication

    const modalHtml = `
    <div id="imageViewerModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100dvh; background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(10px); z-index: 20000; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.3s ease;">
        
        <div style="position: absolute; top: 0; left: 0; width: 100%; padding: 15px 20px; box-sizing: border-box; background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent); pointer-events: none; z-index: 20010; display: flex; justify-content: flex-end;">
            
            <div style="display: flex; align-items: center; pointer-events: auto; gap: 8px;">
                <button title="Download" onclick="downloadViewedImage(event)" class="viewer-btn"><img src="download.svg" style="width:24px; height:24px; filter: brightness(0) invert(1);"></button>
                <button title="Share to User" onclick="shareViewedImage(event)" class="viewer-btn"><img src="share.svg" style="width:24px; height:24px; filter: brightness(0) invert(1);"></button>
                <button title="Photo Info" onclick="showImageInfo(event)" class="viewer-btn"><img src="info2.svg" style="width:24px; height:24px; filter: brightness(0) invert(1);"></button>
                <span style="color: white; font-size: 35px; font-weight: bold; cursor: pointer; margin-left: 10px; line-height: 1;" onclick="closeImageViewer()">&times;</span>
            </div>
        </div>

        <img id="viewerImage" style="max-width: 95vw; max-height: 80dvh; margin-top: 40px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.5); transform: scale(0.9); transition: transform 0.3s ease; pointer-events: auto; object-fit: contain;" src="">

        <div id="shareMenuOverlay" style="display:none; position:absolute; top:70px; right:20px; background:white; width:220px; max-height:300px; border-radius:10px; padding:10px; overflow-y:auto; box-shadow:0 10px 30px rgba(0,0,0,0.5); z-index:20015; pointer-events: auto;">
            <strong style="color:black; padding-bottom:10px; display:block;">Share with...</strong>
            <div id="shareUserList"></div>
        </div>

        <div id="infoMenuOverlay" style="display:none; position:absolute; top:70px; right:20px; background:white; width:250px; border-radius:10px; padding:15px; color:black; box-shadow:0 10px 30px rgba(0,0,0,0.5); z-index:20015; pointer-events: auto;">
            <strong>Photo Details</strong><br><small id="photoInfoText" style="color:#555">Loading...</small>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
});

// ✅ Open the Viewer (stores image and ID details)
window.openImageViewer = function(url, msgId) {
    const modal = document.getElementById('imageViewerModal');
    const img = document.getElementById('viewerImage');
    if (!modal || !img) return;
    
    currentViewedImageUrl = url;
    currentViewedMessageId = msgId;
    img.src = url;
    modal.style.display = 'flex';
    
    setTimeout(() => {
        modal.style.opacity = '1';
        img.style.transform = 'scale(1)';
    }, 10);
};

// ✅ Close the Viewer
window.closeImageViewer = function() {
    const modal = document.getElementById('imageViewerModal');
    const img = document.getElementById('viewerImage');
    const shareOverlay = document.getElementById('shareMenuOverlay');
    const infoOverlay = document.getElementById('infoMenuOverlay');
    
    if (!modal || !img) return;
    
    modal.style.opacity = '0';
    img.style.transform = 'scale(0.9)';
    
    // Reset Overlays
    shareOverlay.style.display = 'none';
    infoOverlay.style.display = 'none';

    setTimeout(() => {
        modal.style.display = 'none';
        img.src = '';
    }, 300);
};

// ==============================================================
// VIEWER ACTION BUTTON HANDLERS
// ==============================================================

// ✅ (1) Download Image Logic
window.downloadViewedImage = function(e) {
    e.stopPropagation(); // Prevents closeImageViewer from firing
    if (!currentViewedImageUrl) return;

    fetch(currentViewedImageUrl)
        .then(response => response.blob())
        .then(blob => {
            const blobUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            // Name the file based on the message ID
            a.download = `chat_image_${currentViewedMessageId}.png`; 
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(blobUrl);
        }).catch(err => {
            console.error('Download failed', err);
            window.open(currentViewedImageUrl, '_blank'); // Fallback to new tab
        });
};

// ✅ (2) Share to User Logic (Internal app sharing)
window.shareViewedImage = function(e) {
    e.stopPropagation(); 
    const shareOverlay = document.getElementById('shareMenuOverlay');
    const userListDiv = document.getElementById('shareUserList');
    document.getElementById('infoMenuOverlay').style.display = 'none'; // Close other menu

    if (shareOverlay.style.display === 'block') {
        shareOverlay.style.display = 'none'; return;
    }

    // Reuse existing contact data structure to build user list
    let users = [];
    globalUsersList.forEach(user => {
        if (user.uid !== currentUser.uid) users.push(user);
    });

    if (users.length === 0) {
        userListDiv.innerHTML = '<small style="color:black;">No users found</small>';
    } else {
        // Build the interactive list
        userListDiv.innerHTML = users.map(user => `
            <div style="color:black; cursor:pointer; padding:8px; border-bottom:1px solid #eee; display:flex; align-items:center;" onclick="executeInternalShare('${user.uid}')">
                <img src="${user.photoURL || '/img/default-pfp.png'}" style="width:25px; height:25px; border-radius:50%; margin-right:8px;" onerror="this.style.display='none'">
                <span>${user.displayName || 'User'}</span>
            </div>
        `).join('');
    }
    shareOverlay.style.display = 'block';
};

// Logic to actually execute the message sending for sharing
window.executeInternalShare = async function(recipientUid) {
    document.getElementById('shareMenuOverlay').style.display = 'none';
    closeImageViewer();

    // Select the new chat first to switch views smoothly
    const newChatElement = document.querySelector(`#usersList [data-uid="${recipientUid}"]`);
    if(newChatElement) newChatElement.click();

    // Prepare shared message (referencing currentUrl)
    const chatId = makeChatId(recipientUid);
    const msgData = {
        imageUrl: currentViewedImageUrl,
        text: '📷 Photo',
        senderId: currentUser.uid,
        senderName: currentUser.displayName || localStorage.getItem('userName') || 'User', // ✅ FIX B
        timestamp: serverTimestamp(),
        chatId: chatId,
        recipientId: recipientUid,
        status: 'sent'
    };

    try {
        await addDoc(collection(db, 'chats', chatId, 'messages'), msgData);
        await setDoc(doc(db, 'chats', chatId), {
            id: chatId, members: [currentUser.uid, recipientUid],
            lastMessage: '📷 Photo', lastMessageSender: currentUser.uid, lastTimestamp: serverTimestamp()
        }, { merge: true });
        showToast("Photo Shared Successfully!");
    } catch (err) { console.error("Internal Share failed", err); }
};

// ✅ (3) Info Logic (Shows metadata about the photo)
window.showImageInfo = async function(e) {
    e.stopPropagation();
    const infoOverlay = document.getElementById('infoMenuOverlay');
    const infoTextDiv = document.getElementById('photoInfoText');
    document.getElementById('shareMenuOverlay').style.display = 'none'; // Close other menu

    if (infoOverlay.style.display === 'block') {
        infoOverlay.style.display = 'none'; return;
    }

    infoOverlay.style.display = 'block';
    infoTextDiv.textContent = 'Loading photo metadata...';

    const chatId = makeChatId(currentChatUser.uid);
    
    // Fetch original document again to get senderName and timestamp
    const msgDoc = await getDoc(doc(db, 'chats', chatId, 'messages', currentViewedMessageId));
    if (msgDoc.exists()) {
        const msg = msgDoc.data();
        let timestampStr = "Unknown";
        if (msg.timestamp?.toDate) {
            timestampStr = msg.timestamp.toDate().toLocaleDateString('en-US', {weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute:'numeric'});
        } else if (msg.timestamp instanceof Date) {
            timestampStr = msg.timestamp.toLocaleDateString();
        }

        // Get dimensions from the currently loaded viewer image
        const imgEl = document.getElementById('viewerImage');
        const width = imgEl ? imgEl.naturalWidth : 'Unknown';
        const height = imgEl ? imgEl.naturalHeight : 'Unknown';
        const resolution = width !== 'Unknown' ? `${width} x ${height} px` : 'Unknown';

        infoTextDiv.innerHTML = `
            <strong>Sent by:</strong> ${msg.senderName || 'Anonymous'}<br>
            <strong>Date:</strong> ${timestampStr}<br>
            <strong>Dimensions:</strong> ${resolution}<br>
            <strong>Message ID:</strong><br>
            <small style="color:#777; font-family:monospace; word-break:break-all;">${currentViewedMessageId}</small>
        `;
    } else {
        infoTextDiv.textContent = 'Unable to fetch original message details.';
    }
};

// (Small simple toast messenger for confirmation)
function showToast(msg) {
    const toast = document.createElement('div');
    toast.style = "position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#333; color:white; padding:10px 20px; border-radius:5px; z-index:99999; opacity:1; transition: opacity 0.3s ease;";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.style.opacity = '0', 2000);
    setTimeout(() => document.body.removeChild(toast), 2300);
}