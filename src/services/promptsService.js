import {
addDoc,
collection,
doc,
getDocs,
limit,
onSnapshot,
orderBy,
query,
runTransaction,
serverTimestamp,
setDoc,
updateDoc,
where,
writeBatch,
increment,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export function subscribeToPromptRecipients(uid, onData, onError) {
const q = query(collection(db, 'promptRecipients'), where('uid', '==', uid));
return onSnapshot(
q,
(snap) => {
const now = Date.now();
const items = snap.docs.map((d) => {
const data = d.data();
const activeLikeStatuses = ['sent', 'opened', 'recording_started'];
const computedStatus =
activeLikeStatuses.includes(data.deliveryStatus) && data.expiresAtClient < now
? 'expired'
: data.deliveryStatus;
return { id: d.id, ...data, computedStatus };
});
onData(items.sort((a, b) => (b.createdAtClient || 0) - (a.createdAtClient || 0)));
},
onError
);
}

export function subscribeToPromptTemplates(onData, onError) {
const q = query(collection(db, 'promptTemplates'), orderBy('createdAtClient', 'desc'));
return onSnapshot(
q,
(snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
onError
);
}

export async function createPromptTemplate(
text,
adminUid,
submittedBy = null
) {
if (!text?.trim()) throw new Error('Prompt text is required.');

return addDoc(collection(db, 'promptTemplates'), {
text: text.trim(),
status: 'active',
createdByAdminUid: adminUid,
submittedByUid: submittedBy?.uid || null,
submittedByDisplayName: submittedBy?.displayName || null,
submittedByUsername: submittedBy?.usernameLower || null,
approvedByAdminUid: adminUid,
issueCount: 0,
lastIssuedAtClient: null,
lastIssuedPromptId: null,
createdAt: serverTimestamp(),
updatedAt: serverTimestamp(),
createdAtClient: Date.now(),
});
}

export async function issueGlobalPrompt({ promptTemplateId, text, adminUid, windowHours = 24 }) {
const cleanText = (text || '').trim();
if (!promptTemplateId && !cleanText) throw new Error('Pick or create a prompt template first.');

const usersSnap = await getDocs(collection(db, 'users'));
const audience = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const now = Date.now();
const expiresAtClient = now + windowHours * 60 * 60 * 1000;

const promptRef = doc(collection(db, 'prompts'));
const promptPayload = {
promptTemplateId: promptTemplateId || null,
textSnapshot: cleanText,
createdByType: 'admin',
issuedByAdminUid: adminUid,
audienceType: 'global',
startAt: serverTimestamp(),
createdAt: serverTimestamp(),
updatedAt: serverTimestamp(),
startAtClient: now,
createdAtClient: now,
expiresAtClient,
responseWindowSeconds: windowHours * 60 * 60,
status: 'preparing',
};

await setDoc(promptRef, promptPayload);

let batch = writeBatch(db);
let opCount = 0;
const flush = async () => {
if (opCount === 0) return;
await batch.commit();
batch = writeBatch(db);
opCount = 0;
};

for (const audienceUser of audience) {
const recipientRef = doc(db, 'promptRecipients', `${promptRef.id}_${audienceUser.id}`);
batch.set(recipientRef, {
promptId: promptRef.id,
uid: audienceUser.id,
deliveryStatus: 'sent',
openedAt: null,
openedAtClient: null,
recordingStartedAtClient: null,
respondedAtClient: null,
forfeitedAtClient: null,
createdAt: serverTimestamp(),
updatedAt: serverTimestamp(),
createdAtClient: now,
promptTextSnapshot: cleanText,
promptTemplateId: promptTemplateId || null,
startAtClient: now,
expiresAtClient,
});
opCount += 1;
if (opCount >= 400) await flush();
}

await flush();

await updateDoc(promptRef, {
status: 'active',
activatedAt: serverTimestamp(),
activatedAtClient: Date.now(),
updatedAt: serverTimestamp(),
});

if (promptTemplateId) {
await updateDoc(doc(db, 'promptTemplates', promptTemplateId), {
issueCount: increment(1),
lastIssuedAtClient: now,
lastIssuedPromptId: promptRef.id,
updatedAt: serverTimestamp(),
});
}

return promptRef.id;
}


export async function getPromptRecipientByPromptId(uid, promptId) {
if (!uid || !promptId) return null;
const q = query(
collection(db, 'promptRecipients'),
where('uid', '==', uid),
where('promptId', '==', promptId),
limit(1)
);
const snap = await getDocs(q);
if (snap.empty) return null;
const docSnap = snap.docs[0];
const data = docSnap.data();
const activeLikeStatuses = ['sent', 'opened', 'recording_started'];
const computedStatus =
activeLikeStatuses.includes(data.deliveryStatus) && data.expiresAtClient < Date.now()
? 'expired'
: data.deliveryStatus;
return { id: docSnap.id, ...data, computedStatus };
}

export async function markNotificationOpened({ deliveryId, uid, promptId }) {
if (!deliveryId || !uid || !promptId) return;
await updateDoc(doc(db, 'notificationDeliveries', deliveryId), {
uid,
promptId,
openedAt: serverTimestamp(),
openedAtClient: Date.now(),
appOpenedFromPush: true,
updatedAt: serverTimestamp(),
});
}

export async function markPromptOpened(recipient) {
const ref = doc(db, 'promptRecipients', recipient.id);
const userRef = doc(db, 'users', recipient.uid);
const now = Date.now();

await runTransaction(db, async (tx) => {
const snap = await tx.get(ref);
if (!snap.exists()) throw new Error('Prompt not found.');

const data = snap.data();
if (['responded', 'forfeited', 'expired', 'opened', 'recording_started'].includes(data.deliveryStatus)) return;

const userSnap = await tx.get(userRef);
const stats = userSnap.exists() ? userSnap.data()?.statsHidden || {} : {};

tx.update(ref, {
deliveryStatus: 'opened',
openedAt: serverTimestamp(),
openedAtClient: now,
updatedAt: serverTimestamp(),
});

tx.set(
userRef,
{
statsHidden: {
...stats,
totalPromptsOpened: (stats.totalPromptsOpened || 0) + 1,
},
updatedAt: serverTimestamp(),
},
{ merge: true }
);
});
}

export async function markRecordingStarted(recipientId) {
const ref = doc(db, 'promptRecipients', recipientId);
await runTransaction(db, async (tx) => {
const snap = await tx.get(ref);
if (!snap.exists()) throw new Error('Prompt not found.');
const data = snap.data();
if (['responded', 'forfeited', 'expired'].includes(data.deliveryStatus)) return;
tx.update(ref, {
deliveryStatus: 'recording_started',
recordingStartedAtClient: Date.now(),
updatedAt: serverTimestamp(),
});
});
}

export async function markPromptForfeited(recipient) {
const ref = doc(db, 'promptRecipients', recipient.id);
const userRef = doc(db, 'users', recipient.uid);
const now = Date.now();

await runTransaction(db, async (tx) => {
const snap = await tx.get(ref);
if (!snap.exists()) throw new Error('Prompt not found.');

const data = snap.data();
if (['responded', 'forfeited'].includes(data.deliveryStatus)) return;

const userSnap = await tx.get(userRef);
const stats = userSnap.exists() ? userSnap.data()?.statsHidden || {} : {};

tx.update(ref, {
deliveryStatus: 'forfeited',
forfeitedAtClient: now,
updatedAt: serverTimestamp(),
});

tx.set(
userRef,
{
statsHidden: {
...stats,
totalPromptsForfeited: (stats.totalPromptsForfeited || 0) + 1,
},
updatedAt: serverTimestamp(),
},
{ merge: true }
);
});
}

export async function markPromptResponded(recipientId) {
await updateDoc(doc(db, 'promptRecipients', recipientId), {
deliveryStatus: 'responded',
respondedAtClient: Date.now(),
updatedAt: serverTimestamp(),
});
}