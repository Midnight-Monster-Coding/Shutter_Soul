// firebase-messaging-sw.js
// Service Worker for Firebase Cloud Messaging (FCM) - Background Notifications

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Initialize Firebase in the service worker
firebase.initializeApp({
    apiKey: "AIzaSyD3rQ3l-AlnJhCOCcA7_h2rQHfdxDz1Of0",
    authDomain: "shutter-soul.firebaseapp.com",
    projectId: "shutter-soul",
    storageBucket: "shutter-soul.appspot.com",
    messagingSenderId: "602126305011",
    appId: "1:602126305011:web:c059836dae27a208e95986",
    measurementId: "G-MSSSHJKN28",
    databaseURL: "https://shutter-soul-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(function(payload) {
    console.log('[firebase-messaging-sw.js] Received background message:', payload);
    
    const data = payload.data || {};
    const notificationTitle = data.title || 'Incoming Call';
    const notificationOptions = {
        body: data.body || `${data.callerName || 'Someone'} is calling you`,
        icon: data.callerPhoto || '/default-avatar.png',
        badge: '/badge-icon.png',
        tag: data.callId || 'incoming-call',
        requireInteraction: true,
        data: {
            callId: data.callId,
            callerId: data.callerId,
            callerName: data.callerName
        },
        actions: [
            { action: 'accept', title: 'Accept', icon: '/accept-icon.png' },
            { action: 'decline', title: 'Decline', icon: '/decline-icon.png' }
        ],
        vibrate: [200, 100, 200, 100, 200, 100, 200]
    };

    return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification clicks
self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification click received.');
    
    event.notification.close();
    
    const action = event.action;
    const callData = event.notification.data || {};
    
    if (action === 'accept') {
        // Open app and accept call
        const url = `/message.html?callId=${encodeURIComponent(callData.callId)}&action=accept`;
        event.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then(function(clientList) {
                    // Check if app is already open
                    for (let i = 0; i < clientList.length; i++) {
                        const client = clientList[i];
                        if (client.url.includes('message.html') && 'focus' in client) {
                            return client.focus().then(client => {
                                return client.postMessage({
                                    type: 'ACCEPT_CALL',
                                    callId: callData.callId
                                });
                            });
                        }
                    }
                    // If app is not open, open it
                    if (clients.openWindow) {
                        return clients.openWindow(url);
                    }
                })
        );
    } else if (action === 'decline') {
        // Decline the call
        event.waitUntil(
            fetch(`/api/decline-call?callId=${callData.callId}`, { method: 'POST' })
                .catch(err => console.error('Error declining call:', err))
        );
    } else {
        // Default action: open the app
        const url = `/message.html?callId=${encodeURIComponent(callData.callId)}`;
        event.waitUntil(clients.openWindow(url));
    }
});