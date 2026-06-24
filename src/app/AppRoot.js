import { StatusBar } from 'expo-status-bar';
import {
CameraView,
useCameraPermissions,
useMicrophonePermissions,
} from 'expo-camera';
import { Video, ResizeMode } from 'expo-av';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
ActivityIndicator,
Alert,
AppState,
FlatList,
Linking,
Platform,
Pressable,
SafeAreaView,
ScrollView,
StyleSheet,
Text,
TextInput,
TouchableOpacity,
View,
} from 'react-native';
import {
createUserWithEmailAndPassword,
onAuthStateChanged,
signInWithEmailAndPassword,
signOut,
} from 'firebase/auth';

import { auth } from '../lib/firebase';
import { registerDeviceForPushNotifications, registerNotificationTapHandler } from '../lib/notifications';
import { deleteMyAccount } from '../services/accountService';
import { uploadVideoForResponse } from '../lib/storage';
import { logEvent } from '../services/analyticsService';
import {
ensureUserProfile,
getProfileById,
isProfileComplete,
saveProfileSetup,
searchUsersByUsername,
subscribeToProfile,
} from '../services/profileService';
import {
acceptFriendRequest,
blockUser,
cancelFriendRequest,
declineFriendRequest,
removeFriend,
sendFriendRequest,
subscribeToFriendships,
subscribeToIncomingBlocks,
subscribeToIncomingRequests,
subscribeToOutgoingBlocks,
subscribeToOutgoingRequests,
unblockUser,
} from '../services/friendsService';
import {
createPromptTemplate,
getPromptRecipientByPromptId,
issueGlobalPrompt,
markNotificationOpened,
markPromptForfeited,
markPromptOpened,
markPromptResponded,
markRecordingStarted,
subscribeToPromptRecipients,
subscribeToPromptTemplates,
} from '../services/promptsService';
import {
createResponseFromTake,
deleteResponse,
subscribeFeedResponses,
subscribeProfileResponses,
subscribeUserResponses,
} from '../services/responsesService';
import { REACTION_TYPES, subscribeMyReactions, toggleReaction } from '../services/reactionsService';
import { reviewPromptSuggestion, submitPromptSuggestion, subscribePromptSuggestions } from '../services/promptSuggestionsService';
import { ONETAKE_TERMS_VERSION, acceptLatestTerms } from '../services/termsService';
import { assertTextAllowed } from '../services/contentFilter';
import { reportResponse, reportBlockedUser } from '../services/moderationService';

const APP_VERSION = 'OneTake';
const TABS = ['prompts', 'feed', 'friends', 'profile'];
const ACTIVE_PROMPT_STATUSES = ['sent', 'opened', 'recording_started'];

function formatTime(dateMs) {
if (!dateMs) return '';
try {
return new Date(dateMs).toLocaleString();
} catch {
return '';
}
}

function timeLeftLabel(expiresAtClient) {
const diff = Math.max(expiresAtClient - Date.now(), 0);
const totalMinutes = Math.floor(diff / 60000);
const hours = Math.floor(totalMinutes / 60);
const minutes = totalMinutes % 60;
if (hours > 0) return `${hours}h ${minutes}m left`;
return `${minutes}m left`;
}

function maskPromptPreview(recipient) {
if (recipient.computedStatus === 'responded' || recipient.computedStatus === 'forfeited') {
return recipient.promptTextSnapshot;
}
return 'New OneTake prompt ready';
}

function chunkPromptSections(responses) {
const map = new Map();
responses.forEach((response) => {
const key = response.promptId;
const existing = map.get(key);
if (existing) {
existing.responses.push(response);
return;
}
map.set(key, {
promptId: key,
promptText: response.promptTextSnapshot,
issuedAtClient: response.promptIssuedAtClient || response.createdAtClient,
responses: [response],
});
});

return Array.from(map.values())
.map((section) => ({
...section,
responses: section.responses.sort((a, b) => (b.createdAtClient || 0) - (a.createdAtClient || 0)),
}))
.sort((a, b) => (b.issuedAtClient || 0) - (a.issuedAtClient || 0));
}

function PrimaryButton({ label, onPress, disabled = false, danger = false, quiet = false }) {
return (
<TouchableOpacity
style={[
styles.button,
quiet ? styles.buttonSecondary : styles.buttonPrimary,
danger ? styles.buttonDanger : null,
disabled ? styles.buttonDisabled : null,
]}
disabled={disabled}
onPress={onPress}
>
<Text style={styles.buttonText}>{label}</Text>
</TouchableOpacity>
);
}

function ScreenHeader({ title, subtitle, right }) {
return (
<View style={styles.headerRow}>
<View style={{ flex: 1 }}>
<Text style={styles.headerTitle}>{title}</Text>
{subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
</View>
{right}
</View>
);
}

function Card({ children, style }) {
return <View style={[styles.card, style]}>{children}</View>;
}

function ReplayableVideo({ uri, containerStyle, tall = false, onReplay, onViewed }) {
const videoRef = useRef(null);
const viewedRef = useRef(false);
const [showReplay, setShowReplay] = useState(false);

const handleReplay = async () => {
if (!showReplay || !videoRef.current) return;
try {
await videoRef.current.setPositionAsync(0);
await videoRef.current.playAsync();
setShowReplay(false);
onReplay?.();
} catch {}
};

return (
<View style={[containerStyle, tall ? styles.tallVideoWrap : null]}>
<Video
ref={videoRef}
style={styles.video}
source={{ uri }}
useNativeControls
resizeMode={ResizeMode.COVER}
isLooping={false}
onPlaybackStatusUpdate={(status) => {
if (!status?.isLoaded) return;
if (status.isPlaying && !viewedRef.current) {
viewedRef.current = true;
onViewed?.();
}
if (status.didJustFinish) {
setShowReplay(true);
} else if (status.isPlaying) {
setShowReplay(false);
}
}}
/>
{showReplay ? (
<Pressable style={styles.replayOverlay} onPress={handleReplay}>
<Text style={styles.replayOverlayText}>Tap to replay</Text>
</Pressable>
) : null}
</View>
);
}

function ResponseIdentity({ username, isCurrentUser = false }) {
return (
<View style={styles.responseIdentityRow}>
<Text style={styles.responseHandleLarge}>@{username || 'user'}</Text>
{isCurrentUser ? (
<View style={styles.youPill}>
<Text style={styles.youPillText}>You</Text>
</View>
) : null}
</View>
);
}

function AuthScreen({ authMode, setAuthMode, email, setEmail, password, setPassword, busy, onSubmit }) {
return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<ScrollView contentContainerStyle={styles.authPageContent}>
<Text style={styles.appTitle}>OneTake</Text>
<Text style={styles.tagline}>One prompt. One reveal. One take.</Text>

<Card style={styles.explainerCard}>
<Text style={styles.explainerTitle}>Answer quick video prompts with friends.</Text>
<Text style={styles.explainerBody}>
Post your take to unlock the reveal and see what everyone else said.
</Text>
<View style={styles.explainerBulletWrap}>
<Text style={styles.explainerBullet}>• One short video per prompt</Text>
<Text style={styles.explainerBullet}>• Friend-only reveal after you post</Text>
<Text style={styles.explainerBullet}>• Reports, blocks, and account controls require sign-in</Text>
</View>
</Card>

<View style={styles.authInputStack}>
<TextInput
style={[styles.input, styles.authInput]}
placeholder="Email"
placeholderTextColor="#7C8BA1"
autoCapitalize="none"
keyboardType="email-address"
value={email}
onChangeText={setEmail}
/>
<TextInput
style={[styles.input, styles.authInput]}
placeholder="Password"
placeholderTextColor="#7C8BA1"
secureTextEntry
value={password}
onChangeText={setPassword}
/>
</View>

<View style={styles.authPrimaryButtonWrap}>
<PrimaryButton
label={busy ? 'Working…' : authMode === 'signup' ? 'Create Account' : 'Sign In'}
onPress={onSubmit}
disabled={busy}
/>
</View>

<PrimaryButton
label={authMode === 'signup' ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
onPress={() => setAuthMode(authMode === 'signup' ? 'signin' : 'signup')}
quiet
/>
<Text style={styles.footnote}>{APP_VERSION}</Text>
</ScrollView>
</SafeAreaView>
);
}

function ProfileSetupScreen({ user, initialProfile, onSave, busy }) {
const [username, setUsername] = useState(initialProfile?.username || '');
const [displayName, setDisplayName] = useState(initialProfile?.displayName || '');
const [bio, setBio] = useState(initialProfile?.bio || '');

useEffect(() => {
setUsername(initialProfile?.username || '');
setDisplayName(initialProfile?.displayName || '');
setBio(initialProfile?.bio || '');
}, [initialProfile?.username, initialProfile?.displayName, initialProfile?.bio]);

return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader title="Finish your profile" subtitle="You need a username and display name before entering the app." />
<Card>
<Text style={styles.label}>Signed in as</Text>
<Text style={styles.valueText}>{user?.email}</Text>
</Card>
<TextInput
style={styles.input}
placeholder="Username"
placeholderTextColor="#7C8BA1"
autoCapitalize="none"
value={username}
onChangeText={setUsername}
/>
<TextInput
style={styles.input}
placeholder="Display name"
placeholderTextColor="#7C8BA1"
value={displayName}
onChangeText={setDisplayName}
/>
<TextInput
style={[styles.input, styles.multilineInput]}
placeholder="Short bio (optional)"
placeholderTextColor="#7C8BA1"
multiline
value={bio}
onChangeText={setBio}
/>
<PrimaryButton label={busy ? 'Saving…' : 'Continue'} onPress={() => onSave({ username, displayName, bio })} disabled={busy} />
</ScrollView>
</SafeAreaView>
);
}

function TermsScreen({ onAccept, busy }) {
return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader title="Community Guidelines & Terms" subtitle="Required before viewing or sharing user-generated content." />
<Card style={styles.explainerCard}>
<Text style={styles.explainerTitle}>Zero tolerance for abuse</Text>
<Text style={styles.bodyCopy}>
OneTake does not allow objectionable content or abusive users. This includes harassment, hate, threats, sexual content, violence, spam, or content that targets, humiliates, or endangers another person.
</Text>
<Text style={styles.bodyCopy}>
Users can report videos and block abusive users. Reported content is sent to the developer for review and action, including removal of content and account restrictions when appropriate.
</Text>
<Text style={styles.bodyCopy}>
By continuing, you agree to use OneTake respectfully and understand that violating these guidelines may result in content removal or account ejection.
</Text>
</Card>
<PrimaryButton label={busy ? 'Saving…' : 'I Agree'} onPress={onAccept} disabled={busy} />
<PrimaryButton
label="View Apple Standard EULA"
quiet
onPress={() => Linking.openURL('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
/>
</ScrollView>
</SafeAreaView>
);
}

function CommitScreen({ recipient, onBack, onOpen }) {
return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<View style={styles.pageContent}>
<ScreenHeader title="Ready for your OneTake?" subtitle={timeLeftLabel(recipient.expiresAtClient)} />
<Card>
<Text style={styles.cardTitle}>Record your answer in one take.</Text>
<Text style={styles.bodyCopy}>Once you post, you can see your friends’ takes.</Text>
<Text style={styles.bodyCopy}>Technical problems will not count as your take.</Text>
<Text style={styles.bodyCopy}>You’ll have 10 seconds before recording begins.</Text>
<Text style={styles.bodyCopy}>Camera and microphone access is required before recording.</Text>
</Card>
<PrimaryButton label="Open Prompt" onPress={onOpen} />
<PrimaryButton label="Not Now" onPress={onBack} quiet />
</View>
</SafeAreaView>
);
}

function CountdownCameraScreen({ recipient, countdown, facing, onFlipCamera, onForfeit }) {
return (
<View style={styles.cameraScreen}>
<StatusBar style="light" />
<CameraView style={styles.cameraPreview} facing={facing} mode="video" />

<View style={styles.countdownOverlay}>
<Text style={styles.countdownPromptText}>{recipient.promptTextSnapshot}</Text>
<Text style={styles.countdownLabel}>Recording starts in</Text>
<Text style={styles.countdownNumber}>{countdown}</Text>
<View style={styles.rowGap}>
<PrimaryButton
label={facing === 'front' ? 'Use back camera' : 'Use front camera'}
onPress={onFlipCamera}
quiet
/>
<PrimaryButton label="Forfeit" onPress={onForfeit} danger />
</View>
</View>
</View>
);
}

function RecordScreen({ recipient, facing, onFlipCamera, onComplete, onForfeit }) {
const [recording, setRecording] = useState(false);
const [seconds, setSeconds] = useState(0);
const [error, setError] = useState('');
const [retryNonce, setRetryNonce] = useState(0);
const cameraRef = useRef(null);
const recordingStartedAtRef = useRef(null);

useEffect(() => {
let interval;
if (recording) {
interval = setInterval(() => setSeconds((value) => value + 1), 1000);
}
return () => interval && clearInterval(interval);
}, [recording]);

useEffect(() => {
let cancelled = false;
let timeout;

async function begin() {
setError('');
setSeconds(0);
timeout = setTimeout(async () => {
if (cancelled || !cameraRef.current) return;
try {
recordingStartedAtRef.current = Date.now();
setRecording(true);
const video = await cameraRef.current.recordAsync({ maxDuration: 30 });
setRecording(false);

if (!video?.uri) {
setError('Recording did not save. You can try again.');
return;
}

const elapsedMs = recordingStartedAtRef.current
? Date.now() - recordingStartedAtRef.current
: 30000;
const durationSeconds = Math.max(1, Math.min(30, Math.round(elapsedMs / 1000)));

onComplete({
localUri: video.uri,
durationSeconds,
});
} catch (err) {
setRecording(false);
setError(err?.message || 'Recording failed. You can try again.');
}
}, 250);
}

begin();

return () => {
cancelled = true;
if (timeout) clearTimeout(timeout);
try {
cameraRef.current?.stopRecording?.();
} catch {}
};
}, [retryNonce, onComplete]);

return (
<View style={styles.cameraScreen}>
<StatusBar style="light" />
<CameraView ref={cameraRef} style={styles.cameraPreview} facing={facing} mode="video" />
<View style={styles.cameraOverlay}>
<Text style={styles.cameraTitle}>{recording ? 'Recording now' : error ? 'Recording paused' : 'Preparing camera'}</Text>
<Text style={styles.cameraSubtitle}>{recipient.promptTextSnapshot}</Text>
<Text style={styles.cameraTimer}>{recording ? `${seconds}s` : 'Preparing camera…'}</Text>
{error ? <Text style={styles.errorInline}>{error}</Text> : null}
<View style={styles.rowGap}>
<PrimaryButton
label={facing === 'front' ? 'Use back camera' : 'Use front camera'}
onPress={onFlipCamera}
quiet
/>
{error ? (
<PrimaryButton label="Try again" onPress={() => setRetryNonce((value) => value + 1)} />
) : null}
<PrimaryButton
label={recording ? 'Stop early' : 'Forfeit'}
onPress={recording ? () => cameraRef.current?.stopRecording?.() : onForfeit}
danger
/>
</View>
</View>
</View>
);
}
function ReviewScreen({ localUri, durationSeconds, uploadBusy, uploadError, onSubmit, onForfeit }) {
return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<View style={styles.pageContent}>
<ScreenHeader title="Review your take" subtitle="Submit this take to unlock the reveal." />
<View style={styles.videoWrap}>
<Video
style={styles.video}
source={{ uri: localUri }}
useNativeControls
resizeMode={ResizeMode.CONTAIN}
isLooping={false}
/>
</View>
<Text style={styles.bodyCopy}>Length: {durationSeconds || 0}s</Text>
{uploadError ? <Text style={styles.errorInline}>{uploadError}</Text> : null}
<PrimaryButton label={uploadBusy ? 'Uploading…' : 'Submit'} onPress={onSubmit} disabled={uploadBusy} />
<PrimaryButton label="Forfeit" onPress={onForfeit} quiet danger />
</View>
</SafeAreaView>
);
}

function FeedScreen({ sections, myReactionMap, onReact, currentUid, onReplay, onViewResponse, onReportResponse, onBlockResponseUser }) {
return (
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader title="Reveal" subtitle="See what your friends said after you post." />
<Card style={styles.moderationNoticeCard}>
<Text style={styles.metaText}>OneTake has zero tolerance for objectionable content or abusive behavior. Use Report or Block on any response that violates the guidelines.</Text>
</Card>
{sections.length === 0 ? (
<Card>
<Text style={styles.bodyCopy}>No friend takes yet. Answer a prompt and add friends to make the reveal come alive.</Text>
</Card>
) : (
sections.map((section) => (
<Card key={section.promptId} style={styles.feedPromptCard}>
<Text style={styles.cardTitle}>{section.promptText}</Text>
<Text style={styles.metaText}>{formatTime(section.issuedAtClient)}</Text>
<Text style={styles.metaText}>
{section.responses.length} visible response{section.responses.length === 1 ? '' : 's'}
</Text>
<FlatList
data={section.responses}
horizontal
keyExtractor={(item) => item.id}
showsHorizontalScrollIndicator={false}
contentContainerStyle={styles.responseRailList}
renderItem={({ item }) => (
<View style={styles.responseRailCard}>
<ResponseIdentity
username={item.authorUsernameSnapshot || 'user'}
isCurrentUser={item.uid === currentUid}
/>
<ReplayableVideo
uri={item.videoUrl}
containerStyle={styles.feedVideoWrap}
tall
onReplay={() => onReplay(item.id, 'feed')}
onViewed={() => onViewResponse(item)}
/>
<Text style={styles.metaText}>{formatTime(item.createdAtClient)}</Text>
<ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.reactionRow}
                    style={styles.reactionScroll}
                  >
{REACTION_TYPES.map((type) => {
const count = item.reactionCounts?.[type] || 0;
const active = myReactionMap[item.id] === type;
return (
<TouchableOpacity
key={type}
style={[styles.reactionChip, active ? styles.reactionChipActive : null]}
onPress={() => onReact(item.id, type)}
>
<Text style={styles.reactionChipText}>{type}</Text>
<Text style={styles.reactionChipCount}>{count}</Text>
</TouchableOpacity>
);
})}
</ScrollView>
{item.uid !== currentUid ? (
<View style={styles.moderationActionRow}>
<PrimaryButton label="Report" onPress={() => onReportResponse(item)} quiet />
<PrimaryButton label="Block User" onPress={() => onBlockResponseUser(item)} quiet danger />
</View>
) : null}
</View>
)}
/>
</Card>
))
)}
</ScrollView>
);
}

function PromptsScreen({ promptRecipients, onOpenPrompt, onSubmitSuggestion, suggestionBusy }) {
const [suggestionText, setSuggestionText] = useState('');
const active = promptRecipients.filter((item) => ACTIVE_PROMPT_STATUSES.includes(item.computedStatus) && item.expiresAtClient > Date.now());

return (
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader title="Prompts" subtitle="Your live prompt inbox." />

<Card style={styles.explainerCard}>
<Text style={styles.explainerTitle}>How OneTake works</Text>
<Text style={styles.explainerBody}>
OneTake is a prompt-based social app. When a prompt is live, you can open it and record one response.
</Text>
<View style={styles.explainerBulletWrap}>
<Text style={styles.explainerBullet}>• Prompts are issued by the app</Text>
<Text style={styles.explainerBullet}>• Opening a prompt starts your one take</Text>
<Text style={styles.explainerBullet}>• Post once to unlock friends’ responses</Text>
</View>
</Card>

<Text style={styles.sectionLabel}>Active</Text>
{active.length === 0 ? (
<Card><Text style={styles.bodyCopy}>No active prompts right now. When a new OneTake is ready, you’ll see it here.</Text></Card>
) : (
active.map((recipient) => (
<Card key={recipient.id}>
<Text style={styles.cardTitle}>{maskPromptPreview(recipient)}</Text>
<Text style={styles.metaText}>{timeLeftLabel(recipient.expiresAtClient)}</Text>
<PrimaryButton label="Open" onPress={() => onOpenPrompt(recipient)} />
</Card>
))
)}

<Text style={styles.sectionLabel}>Suggest a prompt</Text>
<TextInput
style={[styles.input, styles.multilineInput]}
placeholder="Text-only idea for a future prompt"
placeholderTextColor="#7C8BA1"
value={suggestionText}
multiline
onChangeText={setSuggestionText}
/>
<PrimaryButton
label={suggestionBusy ? 'Sending…' : 'Send suggestion'}
onPress={async () => {
await onSubmitSuggestion(suggestionText);
setSuggestionText('');
}}
disabled={suggestionBusy || !suggestionText.trim()}
/>
</ScrollView>
);
}

function FriendProfileScreen({
profile,
responses,
onBack,
isFriend,
blockedByMe,
blockedMe,
onRemoveFriend,
onBlockUser,
onUnblockUser,
onReplay,
onReportResponse,
}) {
const canSeeResponses = isFriend && !blockedByMe && !blockedMe;

return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader
title={profile?.displayName || 'Profile'}
subtitle={`@${profile?.usernameLower || 'unset'}`}
right={<PrimaryButton label="Close" onPress={onBack} quiet />}
/>

<Card>
<Text style={styles.cardTitle}>{profile?.displayName || 'Unknown user'}</Text>
<Text style={styles.metaText}>@{profile?.usernameLower || 'unset'}</Text>
{profile?.bio ? <Text style={styles.bodyCopy}>{profile.bio}</Text> : null}
</Card>

{blockedMe ? (
<Card>
<Text style={styles.bodyCopy}>This user has blocked you.</Text>
</Card>
) : blockedByMe ? (
<PrimaryButton label="Unblock user" onPress={onUnblockUser} quiet />
) : (
<>
{isFriend ? (
<PrimaryButton label="Remove friend" onPress={onRemoveFriend} quiet danger />
) : null}
<PrimaryButton label="Block user" onPress={onBlockUser} quiet danger />
</>
)}

<Text style={styles.sectionLabel}>Submitted responses</Text>
{!canSeeResponses ? (
<Card><Text style={styles.bodyCopy}>Responses visible to friends only.</Text></Card>
) : responses.length === 0 ? (
<Card><Text style={styles.bodyCopy}>No submitted responses yet.</Text></Card>
) : (
responses.map((response) => (
<Card key={response.id}>
<Text style={styles.cardTitle}>{response.promptTextSnapshot}</Text>
<Text style={styles.metaText}>{formatTime(response.createdAtClient)}</Text>
<ReplayableVideo
uri={response.videoUrl}
containerStyle={styles.profileVideoWrap}
tall
onReplay={() => onReplay(response.id, 'friend_profile')}
/>
<View style={styles.moderationActionRow}>
<PrimaryButton label="Report" onPress={() => onReportResponse(response)} quiet />
<PrimaryButton label="Block User" onPress={onBlockUser} quiet danger />
</View>
</Card>
))
)}
</ScrollView>
</SafeAreaView>
);
}

function FriendsScreen({
friends,
incoming,
outgoing,
onAccept,
onDecline,
onCancel,
onSearch,
searchResults,
searchValue,
setSearchValue,
onSendRequest,
onOpenProfile,
currentUid,
friendIdSet,
incomingRequestUidSet,
outgoingRequestUidSet,
}) {
const renderSearchAction = (result) => {
if (result.id === currentUid) return null;

if (friendIdSet.has(result.id)) {
return <PrimaryButton label="View" onPress={() => onOpenProfile(result.id)} quiet />;
}

if (incomingRequestUidSet.has(result.id)) {
return <PrimaryButton label="Requested you" quiet disabled />;
}

if (outgoingRequestUidSet.has(result.id)) {
return <PrimaryButton label="Requested" quiet disabled />;
}

return <PrimaryButton label="Add" onPress={() => onSendRequest(result.id)} />;
};

return (
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader title="Friends" subtitle="Add people so your reveals start to matter." />
<TextInput
style={styles.input}
placeholder="Search by username"
placeholderTextColor="#7C8BA1"
value={searchValue}
autoCapitalize="none"
onChangeText={setSearchValue}
/>
<PrimaryButton label="Search" onPress={onSearch} quiet />

{searchResults.length > 0 ? (
<Card>
{searchResults.map((result) => (
<TouchableOpacity key={result.id} style={styles.userRow} onPress={() => onOpenProfile(result.id)}>
<View style={{ flex: 1 }}>
<Text style={styles.cardTitle}>{result.displayName || result.email || result.id}</Text>
<Text style={styles.metaText}>@{result.usernameLower || 'unset'}</Text>
</View>
{renderSearchAction(result)}
</TouchableOpacity>
))}
</Card>
) : null}

<Text style={styles.sectionLabel}>Incoming requests</Text>
{incoming.length === 0 ? (
<Card><Text style={styles.bodyCopy}>Nothing waiting on you.</Text></Card>
) : (
incoming.map((item) => (
<Card key={item.id}>
<Text style={styles.cardTitle}>{item.user.displayName || item.user.email}</Text>
<Text style={styles.metaText}>@{item.user.usernameLower || 'unset'}</Text>
<View style={styles.rowGap}>
<PrimaryButton label="Accept" onPress={() => onAccept(item.id)} />
<PrimaryButton label="Decline" onPress={() => onDecline(item.id)} quiet danger />
</View>
</Card>
))
)}

<Text style={styles.sectionLabel}>Outgoing requests</Text>
{outgoing.length === 0 ? (
<Card><Text style={styles.bodyCopy}>No pending outgoing requests.</Text></Card>
) : (
outgoing.map((item) => (
<Card key={item.id}>
<Text style={styles.cardTitle}>{item.user.displayName || item.user.email}</Text>
<Text style={styles.metaText}>@{item.user.usernameLower || 'unset'}</Text>
<PrimaryButton label="Cancel request" onPress={() => onCancel(item.id)} quiet />
</Card>
))
)}

<Text style={styles.sectionLabel}>Friends</Text>
{friends.length === 0 ? (
<Card><Text style={styles.bodyCopy}>No friends yet.</Text></Card>
) : (
friends.map((friend) => (
<TouchableOpacity key={friend.id} onPress={() => onOpenProfile(friend.user.id)}>
<Card>
<Text style={styles.cardTitle}>{friend.user.displayName || friend.user.email}</Text>
<Text style={styles.metaText}>@{friend.user.usernameLower || 'unset'}</Text>
</Card>
</TouchableOpacity>
))
)}
</ScrollView>
);
}

function ProfileScreen({ user, profile, myResponses, onDeleteResponse, onDeleteAccount, onSignOut, onOpenAdmin, onReplay }) {
return (
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader title="Profile" subtitle="Your account, your history, your tools." />
<Card>
<Text style={styles.cardTitle}>{profile?.displayName || user?.email}</Text>
<Text style={styles.metaText}>@{profile?.usernameLower || 'unset'}</Text>
<Text style={styles.metaText}>{user?.email}</Text>
<Text style={styles.metaText}>Role: {profile?.role || 'user'}</Text>
{profile?.bio ? <Text style={styles.bodyCopy}>{profile.bio}</Text> : null}
</Card>

{profile?.role === 'admin' ? (
<PrimaryButton label="Open admin tools" onPress={onOpenAdmin} />
) : null}

<Text style={styles.sectionLabel}>My submitted responses</Text>
{myResponses.length === 0 ? (
<Card><Text style={styles.bodyCopy}>You haven’t submitted any takes yet.</Text></Card>
) : (
myResponses.map((response) => (
<Card key={response.id}>
<Text style={styles.cardTitle}>{response.promptTextSnapshot}</Text>
<Text style={styles.metaText}>{formatTime(response.createdAtClient)}</Text>
<ReplayableVideo
uri={response.videoUrl}
containerStyle={styles.profileVideoWrap}
tall
onReplay={() => onReplay(response.id, 'profile')}
/>
<PrimaryButton label="Delete response" onPress={() => onDeleteResponse(response.id)} quiet danger />
</Card>
))
)}

<PrimaryButton label="Delete account" onPress={onDeleteAccount} quiet danger />
<PrimaryButton label="Sign out" onPress={onSignOut} danger />
</ScrollView>
);
}

function AdminScreen({
templates,
suggestions,
newTemplateText,
setNewTemplateText,
onCreateTemplate,
onIssueTemplate,
onReviewSuggestion,
onClose,
}) {
const readyTemplates = templates.filter((item) => !item.issueCount);
const issuedTemplates = templates.filter((item) => (item.issueCount || 0) > 0);

return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<ScrollView contentContainerStyle={styles.pageContent}>
<ScreenHeader
title="Admin tools"
subtitle="Create prompt bank entries and launch a prompt for everyone."
right={<PrimaryButton label="Close" onPress={onClose} quiet />}
/>

<TextInput
style={[styles.input, styles.multilineInput]}
placeholder="New prompt template text"
placeholderTextColor="#7C8BA1"
multiline
value={newTemplateText}
onChangeText={setNewTemplateText}
/>
<PrimaryButton label="Create template" onPress={onCreateTemplate} disabled={!newTemplateText.trim()} />

<Text style={styles.sectionLabel}>Ready to issue</Text>
{readyTemplates.length === 0 ? (
<Card><Text style={styles.bodyCopy}>No unused prompts right now.</Text></Card>
) : (
readyTemplates.map((template) => (
<Card key={template.id}>
<Text style={styles.cardTitle}>{template.text}</Text>
<Text style={styles.metaText}>{formatTime(template.createdAtClient)}</Text>
{template.submittedByDisplayName || template.submittedByUsername ? (
<Text style={styles.metaText}>
Suggested by {template.submittedByDisplayName || 'User'}
{template.submittedByUsername ? ` • @${template.submittedByUsername}` : ''}
</Text>
) : null}
<PrimaryButton label="Issue to all users" onPress={() => onIssueTemplate(template)} />
</Card>
))
)}

<Text style={styles.sectionLabel}>Issued / archive</Text>
{issuedTemplates.length === 0 ? (
<Card><Text style={styles.bodyCopy}>No issued prompts yet.</Text></Card>
) : (
issuedTemplates.map((template) => (
<Card key={template.id}>
<Text style={styles.cardTitle}>{template.text}</Text>
<Text style={styles.metaText}>
Issued {template.issueCount || 0} time{(template.issueCount || 0) === 1 ? '' : 's'}
</Text>
<Text style={styles.metaText}>
Last issued {template.lastIssuedAtClient ? formatTime(template.lastIssuedAtClient) : '—'}
</Text>
{template.submittedByDisplayName || template.submittedByUsername ? (
<Text style={styles.metaText}>
Suggested by {template.submittedByDisplayName || 'User'}
{template.submittedByUsername ? ` • @${template.submittedByUsername}` : ''}
</Text>
) : null}
<PrimaryButton label="Issue again" onPress={() => onIssueTemplate(template)} quiet />
</Card>
))
)}

<Text style={styles.sectionLabel}>Pending suggestions</Text>
{suggestions.filter((item) => item.status === 'pending').length === 0 ? (
<Card><Text style={styles.bodyCopy}>No pending suggestions.</Text></Card>
) : (
suggestions
.filter((item) => item.status === 'pending')
.map((item) => (
<Card key={item.id}>
<Text style={styles.cardTitle}>{item.text}</Text>
<Text style={styles.metaText}>
Suggested by {item.submittedByDisplayName || 'User'}
{item.submittedByUsername ? ` • @${item.submittedByUsername}` : ''}
</Text>
<View style={styles.rowGap}>
<PrimaryButton label="Approve" onPress={() => onReviewSuggestion(item, 'approved')} />
<PrimaryButton label="Reject" onPress={() => onReviewSuggestion(item, 'rejected')} quiet danger />
</View>
</Card>
))
)}
</ScrollView>
</SafeAreaView>
);
}

export default function AppRoot() {
const [authLoading, setAuthLoading] = useState(true);
const [authMode, setAuthMode] = useState('signin');
const [authBusy, setAuthBusy] = useState(false);
const [email, setEmail] = useState('');
const [password, setPassword] = useState('');
const [user, setUser] = useState(null);
const [profile, setProfile] = useState(null);
const [profileBusy, setProfileBusy] = useState(false);
const [tab, setTab] = useState('prompts');
const [friends, setFriends] = useState([]);
const [incomingRequests, setIncomingRequests] = useState([]);
const [outgoingRequests, setOutgoingRequests] = useState([]);
const [outgoingBlocks, setOutgoingBlocks] = useState([]);
const [incomingBlocks, setIncomingBlocks] = useState([]);
const [promptRecipients, setPromptRecipients] = useState([]);
const [feedResponses, setFeedResponses] = useState([]);
const [myResponses, setMyResponses] = useState([]);
const [myReactionMap, setMyReactionMap] = useState({});
const [searchValue, setSearchValue] = useState('');
const [searchResults, setSearchResults] = useState([]);
const [searchBusy, setSearchBusy] = useState(false);
const [modalScreen, setModalScreen] = useState(null);
const [activeRecipient, setActiveRecipient] = useState(null);
const [countdown, setCountdown] = useState(10);
const [reviewTake, setReviewTake] = useState(null);
const [uploadBusy, setUploadBusy] = useState(false);
const [uploadError, setUploadError] = useState('');
const [templates, setTemplates] = useState([]);
const [suggestions, setSuggestions] = useState([]);
const [newTemplateText, setNewTemplateText] = useState('');
const [suggestionBusy, setSuggestionBusy] = useState(false);
const [viewedProfile, setViewedProfile] = useState(null);
const [viewedProfileResponses, setViewedProfileResponses] = useState([]);
const [cameraFacing, setCameraFacing] = useState('front');
const [termsBusy, setTermsBusy] = useState(false);
const [hiddenResponseIds, setHiddenResponseIds] = useState([]);
const [hiddenUidList, setHiddenUidList] = useState([]);
const [pendingNotificationData, setPendingNotificationData] = useState(null);
const handledNotificationIdsRef = useRef(new Set());
const [cameraPermission, requestCameraPermission] = useCameraPermissions();
const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
const appStateRef = useRef(AppState.currentState);

useEffect(() => {
const unsub = onAuthStateChanged(auth, async (currentUser) => {
setUser(currentUser || null);
setAuthLoading(false);
if (currentUser) {
await ensureUserProfile(currentUser);
await logEvent('app_open', currentUser);
}
});
return unsub;
}, []);

useEffect(() => {
if (!user?.uid) {
setProfile(null);
return;
}
return subscribeToProfile(user.uid, setProfile, (err) => Alert.alert('Profile error', err.message || String(err)));
}, [user?.uid]);

useEffect(() => {
if (!user?.uid || !isProfileComplete(profile)) return;
const unsubs = [
subscribeToFriendships(user.uid, setFriends, () => {}),
subscribeToIncomingRequests(user.uid, setIncomingRequests, () => {}),
subscribeToOutgoingRequests(user.uid, setOutgoingRequests, () => {}),
subscribeToOutgoingBlocks(user.uid, setOutgoingBlocks, () => {}),
subscribeToIncomingBlocks(user.uid, setIncomingBlocks, () => {}),
subscribeToPromptRecipients(user.uid, setPromptRecipients, () => {}),
subscribeUserResponses(user.uid, setMyResponses, () => {}),
subscribeMyReactions(user.uid, setMyReactionMap, () => {}),
];
return () => unsubs.forEach((unsub) => unsub && unsub());
}, [user?.uid, profile?.usernameLower]);

useEffect(() => {
if (!user?.uid || !isProfileComplete(profile)) return;

logEvent('notification_permission_requested', user).catch(() => {});
registerDeviceForPushNotifications(user.uid)
.then((result) => {
logEvent(result?.token ? 'push_token_registered' : 'push_token_registration_failed', user, {
status: result?.status || null,
requested: result?.requested || false,
platform: Platform.OS,
}).catch(() => {});
if (result?.status === 'granted') {
logEvent('notification_permission_granted', user, {
requested: result?.requested || false,
platform: Platform.OS,
}).catch(() => {});
}
})
.catch((error) => {
console.log('push registration failed', error?.message || error);
logEvent('push_token_registration_failed', user, {
message: error?.message || String(error),
platform: Platform.OS,
}).catch(() => {});
});
}, [user?.uid, profile?.usernameLower]);

useEffect(() => {
if (!user?.uid || !isProfileComplete(profile)) return undefined;

const unsubscribe = registerNotificationTapHandler((data) => {
if (data?.type === 'new_prompt') {
setPendingNotificationData(data);
}
});

return unsubscribe;
}, [user?.uid, profile?.usernameLower]);

const blockedByMeUidSet = useMemo(
() => new Set(outgoingBlocks.map((item) => item.blockedUid).filter(Boolean)),
[outgoingBlocks]
);

const blockedMeUidSet = useMemo(
() => new Set(incomingBlocks.map((item) => item.blockerUid).filter(Boolean)),
[incomingBlocks]
);

const blockedEitherUidSet = useMemo(() => {
const merged = new Set();
blockedByMeUidSet.forEach((id) => merged.add(id));
blockedMeUidSet.forEach((id) => merged.add(id));
return merged;
}, [blockedByMeUidSet, blockedMeUidSet]);

const hiddenResponseIdSet = useMemo(() => new Set(hiddenResponseIds), [hiddenResponseIds]);
const hiddenUidSet = useMemo(() => new Set(hiddenUidList), [hiddenUidList]);

const visibleFriends = useMemo(
() => friends.filter((item) => item.user?.id && !blockedEitherUidSet.has(item.user.id) && !hiddenUidSet.has(item.user.id)),
[friends, blockedEitherUidSet, hiddenUidSet]
);

const visibleIncomingRequests = useMemo(
() => incomingRequests.filter((item) => item.user?.id && !blockedEitherUidSet.has(item.user.id)),
[incomingRequests, blockedEitherUidSet]
);

const visibleOutgoingRequests = useMemo(
() => outgoingRequests.filter((item) => item.user?.id && !blockedEitherUidSet.has(item.user.id)),
[outgoingRequests, blockedEitherUidSet]
);

useEffect(() => {
if (!user?.uid || !isProfileComplete(profile)) return;
const visibleIds = [user.uid, ...visibleFriends.map((item) => item.user?.id).filter(Boolean)];
return subscribeFeedResponses(visibleIds, setFeedResponses, () => {});
}, [user?.uid, profile?.usernameLower, visibleFriends]);

useEffect(() => {
if (profile?.role === 'admin') {
const unsubs = [
subscribeToPromptTemplates(setTemplates, () => {}),
subscribePromptSuggestions(setSuggestions, () => {}),
];
return () => unsubs.forEach((unsub) => unsub && unsub());
}
setTemplates([]);
setSuggestions([]);
}, [profile?.role]);

useEffect(() => {
if (modalScreen !== 'reveal') return undefined;
setCountdown(10);
const timer = setInterval(() => {
setCountdown((value) => {
if (value <= 1) {
clearInterval(timer);
setModalScreen('record');
if (activeRecipient?.id) {
markRecordingStarted(activeRecipient.id).catch(() => {});
logEvent('recording_started', user, {
promptId: activeRecipient.promptId,
recipientId: activeRecipient.id,
});
}
return 0;
}
return value - 1;
});
}, 1000);
return () => clearInterval(timer);
}, [modalScreen, activeRecipient?.id, user]);

useEffect(() => {
const sub = AppState.addEventListener('change', async (nextState) => {
const previous = appStateRef.current;
appStateRef.current = nextState;
if (previous === 'active' && nextState.match(/inactive|background/)) {
if ((modalScreen === 'reveal' || modalScreen === 'record') && activeRecipient) {
try {
await logEvent('recording_interrupted', user, {
promptId: activeRecipient.promptId,
recipientId: activeRecipient.id,
reason: 'backgrounded',
});
} catch {}
setActiveRecipient(null);
setModalScreen(null);
setReviewTake(null);
setUploadError('');
setTab('prompts');
}
}
});
return () => sub.remove();
}, [modalScreen, activeRecipient, user]);

const friendIdSet = useMemo(
() => new Set(visibleFriends.map((item) => item.user?.id).filter(Boolean)),
[visibleFriends]
);

useEffect(() => {
if (modalScreen !== 'friendProfile' || !viewedProfile?.id) {
setViewedProfileResponses([]);
return undefined;
}

const canViewResponses =
friendIdSet.has(viewedProfile.id) &&
!blockedByMeUidSet.has(viewedProfile.id) &&
!blockedMeUidSet.has(viewedProfile.id);

if (!canViewResponses) {
setViewedProfileResponses([]);
return undefined;
}

return subscribeProfileResponses(
viewedProfile.id,
setViewedProfileResponses,
() => {}
);
}, [modalScreen, viewedProfile?.id, blockedByMeUidSet, blockedMeUidSet, friendIdSet]);

const feedSections = useMemo(
() => chunkPromptSections(
feedResponses.filter((item) => !blockedEitherUidSet.has(item.uid) && !hiddenUidSet.has(item.uid) && !hiddenResponseIdSet.has(item.id))
),
[feedResponses, blockedEitherUidSet, hiddenUidSet, hiddenResponseIdSet]
);

const incomingRequestUidSet = useMemo(
() => new Set(visibleIncomingRequests.map((item) => item.user?.id).filter(Boolean)),
[visibleIncomingRequests]
);

const outgoingRequestUidSet = useMemo(
() => new Set(visibleOutgoingRequests.map((item) => item.user?.id).filter(Boolean)),
[visibleOutgoingRequests]
);

const ensureRecordingPermissions = async () => {
let cameraGranted = cameraPermission?.granted === true;
let microphoneGranted = microphonePermission?.granted === true;

if (!cameraGranted) {
const cameraResult = await requestCameraPermission();
cameraGranted = cameraResult?.granted === true;
}

if (!microphoneGranted) {
const microphoneResult = await requestMicrophonePermission();
microphoneGranted = microphoneResult?.granted === true;
}

if (!cameraGranted || !microphoneGranted) {
Alert.alert(
'Permissions needed',
'Camera and microphone access are required before starting your OneTake. If you already denied them, open Settings and turn both permissions on for OneTake.',
[
{ text: 'Cancel', style: 'cancel' },
{
text: 'Open Settings',
onPress: async () => {
try {
await Linking.openSettings();
} catch {
Alert.alert('Unable to open settings', 'Please open the Settings app manually and enable Camera and Microphone for OneTake.');
}
},
},
]
);
return false;
}

return true;
};

const doAuthSubmit = async () => {
if (!email.trim() || !password.trim()) {
Alert.alert('Missing details', 'Enter email and password.');
return;
}
if (password.trim().length < 6) {
Alert.alert('Password too short', 'Use at least 6 characters.');
return;
}
setAuthBusy(true);
try {
if (authMode === 'signup') {
const cred = await createUserWithEmailAndPassword(auth, email.trim(), password.trim());
await logEvent('auth_signup', cred.user);
} else {
const cred = await signInWithEmailAndPassword(auth, email.trim(), password.trim());
await logEvent('auth_signin', cred.user);
}
setPassword('');
} catch (err) {
Alert.alert('Auth error', err?.message || String(err));
} finally {
setAuthBusy(false);
}
};

const doProfileSave = async ({ username, displayName, bio }) => {
setProfileBusy(true);
try {
assertTextAllowed(username, 'Username');
assertTextAllowed(displayName, 'Display name');
assertTextAllowed(bio, 'Bio');
await saveProfileSetup({
uid: user.uid,
email: user.email,
username,
displayName,
bio,
});
await logEvent('profile_completed', user, {
username: username?.trim()?.toLowerCase?.() || '',
});
} catch (err) {
Alert.alert('Profile error', err?.message || String(err));
} finally {
setProfileBusy(false);
}
};

const handleAcceptTerms = async () => {
setTermsBusy(true);
try {
await acceptLatestTerms(user.uid);
await logEvent('terms_accepted', user, { version: ONETAKE_TERMS_VERSION });
} catch (err) {
Alert.alert('Terms error', err?.message || String(err));
} finally {
setTermsBusy(false);
}
};

const openPrompt = useCallback((recipient) => {
if (!recipient) return;
if (!ACTIVE_PROMPT_STATUSES.includes(recipient.computedStatus)) {
if (recipient.computedStatus === 'responded') {
setModalScreen(null);
setTab('feed');
return;
}
Alert.alert('Not available', 'That prompt can no longer be opened.');
return;
}
if (recipient.expiresAtClient < Date.now()) {
Alert.alert('Expired', 'That prompt has expired.');
setTab('prompts');
return;
}
setCameraFacing('front');
setActiveRecipient(recipient);
setModalScreen('commit');
}, []);

useEffect(() => {
if (!pendingNotificationData || !user?.uid || !isProfileComplete(profile)) return undefined;

let cancelled = false;

async function processNotificationOpen() {
const promptId = pendingNotificationData?.promptId || null;
const deliveryId = pendingNotificationData?.deliveryId || null;
const dedupeKey = deliveryId || promptId || JSON.stringify(pendingNotificationData);

if (dedupeKey && handledNotificationIdsRef.current.has(dedupeKey)) {
setPendingNotificationData(null);
return;
}
if (dedupeKey) handledNotificationIdsRef.current.add(dedupeKey);

try {
await logEvent('notification_opened', user, { promptId, deliveryId });
if (deliveryId && promptId) {
await markNotificationOpened({ deliveryId, uid: user.uid, promptId }).catch(() => {});
}

let recipient = promptRecipients.find((item) => item.promptId === promptId) || null;
if (!recipient && promptId) {
recipient = await getPromptRecipientByPromptId(user.uid, promptId);
}

if (cancelled) return;

if (!recipient) {
setModalScreen(null);
setTab('prompts');
return;
}

if (recipient.computedStatus === 'responded') {
setModalScreen(null);
setTab('feed');
return;
}

openPrompt(recipient);
} catch (err) {
console.log('notification routing failed', err?.message || err);
setTab('prompts');
} finally {
if (!cancelled) setPendingNotificationData(null);
}
}

processNotificationOpen();

return () => {
cancelled = true;
};
}, [pendingNotificationData, user?.uid, profile?.usernameLower, promptRecipients, openPrompt]);

const handleCommitOpen = async () => {
try {
const permissionsReady = await ensureRecordingPermissions();
if (!permissionsReady) return;

await markPromptOpened(activeRecipient);
await logEvent('prompt_opened', user, {
promptId: activeRecipient.promptId,
recipientId: activeRecipient.id,
});
setActiveRecipient({ ...activeRecipient, computedStatus: 'opened' });
setModalScreen('reveal');
} catch (err) {
Alert.alert('Prompt error', err?.message || String(err));
}
};

const doForfeitActiveRecipient = async () => {
try {
if (activeRecipient) {
await markPromptForfeited(activeRecipient);
await logEvent('prompt_forfeited', user, {
promptId: activeRecipient.promptId,
recipientId: activeRecipient.id,
reason: 'user_forfeit',
});
}
} catch (err) {
Alert.alert('Forfeit error', err?.message || String(err));
} finally {
setModalScreen(null);
setActiveRecipient(null);
setReviewTake(null);
setUploadError('');
setCameraFacing('front');
}
};

const handleRecordComplete = useCallback(async ({ localUri, durationSeconds }) => {
setReviewTake({ localUri, durationSeconds });
setModalScreen('review');
await logEvent('recording_completed', user, {
promptId: activeRecipient?.promptId || null,
recipientId: activeRecipient?.id || null,
durationSeconds,
});
}, [activeRecipient?.id, activeRecipient?.promptId, user]);

const handleSubmitReview = async () => {
if (!reviewTake?.localUri || !activeRecipient || !profile) return;
setUploadBusy(true);
setUploadError('');
try {
const responseId = activeRecipient.id;
await logEvent('response_upload_started', user, {
promptId: activeRecipient.promptId,
recipientId: activeRecipient.id,
responseId,
durationSeconds: reviewTake.durationSeconds,
});
const { storagePath, downloadURL } = await uploadVideoForResponse({
userId: user.uid,
responseId,
localUri: reviewTake.localUri,
});
await createResponseFromTake({
responseId,
recipient: activeRecipient,
user: { ...profile, uid: user.uid, email: user.email },
downloadURL,
storagePath,
localUri: reviewTake.localUri,
durationSeconds: reviewTake.durationSeconds,
});
await markPromptResponded(activeRecipient.id);
await logEvent('response_published', user, {
promptId: activeRecipient.promptId,
recipientId: activeRecipient.id,
responseId,
durationSeconds: reviewTake.durationSeconds,
});
await logEvent('feed_revealed', user, {
promptId: activeRecipient.promptId,
recipientId: activeRecipient.id,
responseId,
});
setModalScreen(null);
setActiveRecipient(null);
setReviewTake(null);
setCameraFacing('front');
setTab('feed');
} catch (err) {
await logEvent('response_upload_failed', user, {
promptId: activeRecipient?.promptId || null,
recipientId: activeRecipient?.id || null,
message: err?.message || 'unknown error',
});
setUploadError(err?.message || String(err));
} finally {
setUploadBusy(false);
}
};

const handleSearch = async () => {
setSearchBusy(true);
try {
const results = await searchUsersByUsername(searchValue);
const filtered = results.filter(
(item) => item.id !== user.uid && !blockedEitherUidSet.has(item.id)
);
setSearchResults(filtered);
} catch (err) {
Alert.alert('Search error', err?.message || String(err));
} finally {
setSearchBusy(false);
}
};

const requestFriend = async (targetUid) => {
try {
if (blockedByMeUidSet.has(targetUid)) {
Alert.alert('Blocked', 'You have blocked this user. Unblock them first.');
return;
}

if (blockedMeUidSet.has(targetUid)) {
Alert.alert('Unavailable', 'You cannot interact with this user.');
return;
}

if (friendIdSet.has(targetUid)) {
Alert.alert('Already friends', 'This user is already in your friends list.');
return;
}

if (outgoingRequestUidSet.has(targetUid)) {
Alert.alert('Already requested', 'You already sent this user a request.');
return;
}

if (incomingRequestUidSet.has(targetUid)) {
Alert.alert('Pending request', 'This user already requested you. Accept them from Incoming requests.');
return;
}

await sendFriendRequest(user.uid, targetUid);
await logEvent('friend_request_sent', user, { targetUid });
Alert.alert('Sent', 'Friend request sent.');
handleSearch();
} catch (err) {
Alert.alert('Friend request', err?.message || String(err));
}
};

const handleAcceptRequest = async (requestId) => {
try {
const item = incomingRequests.find((req) => req.id === requestId);
await acceptFriendRequest(requestId);
await logEvent('friend_request_accepted', user, {
requestId,
fromUid: item?.user?.id || null,
});
} catch (err) {
Alert.alert('Accept error', err?.message || String(err));
}
};

const handleDeclineRequest = async (requestId) => {
try {
await declineFriendRequest(requestId);
await logEvent('friend_request_declined', user, { requestId });
} catch (err) {
Alert.alert('Decline error', err?.message || String(err));
}
};

const handleCancelRequest = async (requestId) => {
try {
await cancelFriendRequest(requestId);
await logEvent('friend_request_cancelled', user, { requestId });
} catch (err) {
Alert.alert('Cancel error', err?.message || String(err));
}
};

const handleOpenUserProfile = async (targetUid) => {
try {
const targetProfile = await getProfileById(targetUid);
if (!targetProfile) {
Alert.alert('Profile not found', 'That user profile could not be loaded.');
return;
}
setViewedProfile(targetProfile);
setModalScreen('friendProfile');
} catch (err) {
Alert.alert('Profile error', err?.message || String(err));
}
};

const handleRemoveFriend = async () => {
if (!viewedProfile?.id) return;
Alert.alert('Remove friend?', 'This will remove the friendship.', [
{ text: 'Cancel', style: 'cancel' },
{
text: 'Remove',
style: 'destructive',
onPress: async () => {
try {
await removeFriend(user.uid, viewedProfile.id);
await logEvent('friend_removed', user, { targetUid: viewedProfile.id });
Alert.alert('Removed', 'Friend removed.');
setModalScreen(null);
setViewedProfile(null);
setViewedProfileResponses([]);
} catch (err) {
Alert.alert('Remove friend error', err?.message || String(err));
}
},
},
]);
};

const handleBlockUser = async () => {
if (!viewedProfile?.id) return;
Alert.alert('Block user?', 'Blocking will also remove any friendship or pending request.', [
{ text: 'Cancel', style: 'cancel' },
{
text: 'Block',
style: 'destructive',
onPress: async () => {
try {
await blockUser(user.uid, viewedProfile.id);
await reportBlockedUser({
reporterUid: user.uid,
blockedUid: viewedProfile.id,
reason: 'Blocked from profile',
source: 'profile_block',
});
setHiddenUidList((prev) => Array.from(new Set([...prev, viewedProfile.id])));
await logEvent('user_blocked', user, { targetUid: viewedProfile.id });
Alert.alert('Blocked', 'User blocked and their content has been removed from your view.');
setModalScreen(null);
setViewedProfile(null);
setViewedProfileResponses([]);
setSearchResults((prev) => prev.filter((item) => item.id !== viewedProfile.id));
} catch (err) {
Alert.alert('Block error', err?.message || String(err));
}
},
},
]);
};

const handleUnblockUser = async () => {
if (!viewedProfile?.id) return;
try {
await unblockUser(user.uid, viewedProfile.id);
await logEvent('user_unblocked', user, { targetUid: viewedProfile.id });
Alert.alert('Unblocked', 'User unblocked.');
setModalScreen(null);
setViewedProfile(null);
setViewedProfileResponses([]);
} catch (err) {
Alert.alert('Unblock error', err?.message || String(err));
}
};

const handleCreateTemplate = async () => {
try {
await createPromptTemplate(newTemplateText, user.uid);
await logEvent('prompt_template_created', user, {
textLength: newTemplateText.trim().length,
});
setNewTemplateText('');
} catch (err) {
Alert.alert('Template error', err?.message || String(err));
}
};

const handleIssueTemplate = async (template) => {
try {
await issueGlobalPrompt({ promptTemplateId: template.id, text: template.text, adminUid: user.uid });
await logEvent('prompt_issued', user, {
promptTemplateId: template.id,
});
Alert.alert('Prompt issued', 'The prompt is now live for all users.');
} catch (err) {
Alert.alert('Issue error', err?.message || String(err));
}
};

const handleSuggestionSubmit = async (text) => {
if (!text?.trim()) return;
setSuggestionBusy(true);
try {
assertTextAllowed(text, 'Prompt suggestion');
await submitPromptSuggestion(text.trim(), {
uid: user.uid,
displayName: profile?.displayName || null,
usernameLower: profile?.usernameLower || null,
});
await logEvent('prompt_suggestion_submitted', user, {
textLength: text.trim().length,
});
Alert.alert('Suggestion saved', 'Your idea is now waiting in the admin review queue.');
} catch (err) {
Alert.alert('Suggestion error', err?.message || String(err));
} finally {
setSuggestionBusy(false);
}
};

const handleReaction = async (responseId, type) => {
try {
await toggleReaction({ responseId, uid: user.uid, nextType: type });
await logEvent('reaction_sent', user, { responseId, type });
} catch (err) {
Alert.alert('Reaction error', err?.message || String(err));
}
};

const handleDeleteResponse = async (responseId) => {
Alert.alert('Delete response?', 'This removes the reply from your feed and profile.', [
{ text: 'Cancel', style: 'cancel' },
{
text: 'Delete',
style: 'destructive',
onPress: async () => {
try {
await deleteResponse(responseId);
await logEvent('response_deleted', user, { responseId });
} catch (err) {
Alert.alert('Delete error', err?.message || String(err));
}
},
},
]);
};

const handleReportResponse = async (response) => {
if (!response?.id) return;
const reasons = [
'Harassment or bullying',
'Hate or abusive content',
'Sexual content',
'Violence or dangerous behavior',
'Spam',
'Other',
];

Alert.alert(
'Report content?',
'This will send the response to OneTake for review. Reports are reviewed and acted on within 24 hours.',
[
{ text: 'Cancel', style: 'cancel' },
...reasons.map((reason) => ({
text: reason,
onPress: async () => {
try {
setHiddenResponseIds((prev) => Array.from(new Set([...prev, response.id])));
await reportResponse({ reporterUid: user.uid, response, reason, action: 'report' });
await logEvent('response_reported', user, { responseId: response.id, reason });
Alert.alert('Report sent', 'Thank you. This content has been hidden from your view and sent for review.');
} catch (err) {
Alert.alert('Report error', err?.message || String(err));
}
},
})),
]
);
};

const handleBlockResponseUser = async (response) => {
if (!response?.uid) return;
Alert.alert(
'Block user?',
'Blocking this user will remove their content from your feed immediately and notify OneTake for review.',
[
{ text: 'Cancel', style: 'cancel' },
{
text: 'Block User',
style: 'destructive',
onPress: async () => {
try {
setHiddenUidList((prev) => Array.from(new Set([...prev, response.uid])));
await blockUser(user.uid, response.uid);
await reportResponse({
reporterUid: user.uid,
response,
reason: 'Blocked abusive user',
action: 'block',
});
await logEvent('user_blocked_from_response', user, { targetUid: response.uid, responseId: response.id });
Alert.alert('Blocked', 'This user has been blocked and their content has been removed from your feed.');
} catch (err) {
Alert.alert('Block error', err?.message || String(err));
}
},
},
]
);
};

const handleReviewSuggestion = async (suggestion, status) => {
try {
await reviewPromptSuggestion({ suggestionId: suggestion.id, adminUid: user.uid, status });
await logEvent('prompt_suggestion_reviewed', user, {
suggestionId: suggestion.id,
status,
});
if (status === 'approved') {
await createPromptTemplate(suggestion.text, user.uid, {
uid: suggestion.submittedByUid || null,
displayName: suggestion.submittedByDisplayName || null,
usernameLower: suggestion.submittedByUsername || null,
});
}
Alert.alert('Updated', `Suggestion ${status}.`);
} catch (err) {
Alert.alert('Review error', err?.message || String(err));
}
};

const handleViewResponse = async (response) => {
if (!response?.id) return;
await logEvent('friend_response_viewed', user, {
responseId: response.id,
promptId: response.promptId || null,
authorUid: response.uid || null,
isOwnResponse: response.uid === user?.uid,
});
};

const handleReplayEvent = async (responseId, surface) => {
await logEvent('response_replayed', user, { responseId, surface });
};

const handleDeleteAccount = async () => {
Alert.alert(
'Delete account?',
'This permanently deletes your account, profile, responses, friend connections, prompt history, and saved notification tokens. This cannot be undone.',
[
{ text: 'Cancel', style: 'cancel' },
{
text: 'Delete account',
style: 'destructive',
onPress: async () => {
try {
await logEvent('account_delete_requested', user);
await deleteMyAccount();
setTab('prompts');
setModalScreen(null);
setActiveRecipient(null);
setViewedProfile(null);
setViewedProfileResponses([]);
} catch (err) {
Alert.alert('Delete account error', err?.message || String(err));
}
},
},
]
);
};

const handleSignOut = async () => {
try {
await logEvent('sign_out', user);
await signOut(auth);
setTab('prompts');
setModalScreen(null);
setActiveRecipient(null);
setViewedProfile(null);
setViewedProfileResponses([]);
setCameraFacing('front');
} catch (err) {
Alert.alert('Sign out error', err?.message || String(err));
}
};

if (authLoading) {
return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<View style={styles.centeredContainer}>
<ActivityIndicator size="large" color="#ffffff" />
<Text style={styles.bodyCopy}>Loading OneTake…</Text>
</View>
</SafeAreaView>
);
}

if (!user) {
return (
<AuthScreen
authMode={authMode}
setAuthMode={setAuthMode}
email={email}
setEmail={setEmail}
password={password}
setPassword={setPassword}
busy={authBusy}
onSubmit={doAuthSubmit}
/>
);
}

if (!isProfileComplete(profile)) {
return <ProfileSetupScreen user={user} initialProfile={profile} onSave={doProfileSave} busy={profileBusy} />;
}

if (profile?.acceptedTermsVersion !== ONETAKE_TERMS_VERSION) {
return <TermsScreen onAccept={handleAcceptTerms} busy={termsBusy} />;
}

if (modalScreen === 'commit' && activeRecipient) {
return <CommitScreen recipient={activeRecipient} onBack={() => setModalScreen(null)} onOpen={handleCommitOpen} />;
}

if (modalScreen === 'reveal' && activeRecipient) {
return (
<CountdownCameraScreen
recipient={activeRecipient}
countdown={countdown}
facing={cameraFacing}
onFlipCamera={() => setCameraFacing((value) => (value === 'front' ? 'back' : 'front'))}
onForfeit={doForfeitActiveRecipient}
/>
);
}

if (modalScreen === 'record' && activeRecipient) {
return (
<RecordScreen
recipient={activeRecipient}
facing={cameraFacing}
onFlipCamera={() => setCameraFacing((value) => (value === 'front' ? 'back' : 'front'))}
onComplete={handleRecordComplete}
onForfeit={doForfeitActiveRecipient}
/>
);
}

if (modalScreen === 'review' && activeRecipient && reviewTake) {
return (
<ReviewScreen
localUri={reviewTake.localUri}
durationSeconds={reviewTake.durationSeconds}
uploadBusy={uploadBusy}
uploadError={uploadError}
onSubmit={handleSubmitReview}
onForfeit={doForfeitActiveRecipient}
/>
);
}

if (modalScreen === 'admin') {
return (
<AdminScreen
templates={templates}
suggestions={suggestions}
newTemplateText={newTemplateText}
setNewTemplateText={setNewTemplateText}
onCreateTemplate={handleCreateTemplate}
onIssueTemplate={handleIssueTemplate}
onReviewSuggestion={handleReviewSuggestion}
onClose={() => setModalScreen(null)}
/>
);
}

if (modalScreen === 'friendProfile' && viewedProfile) {
const viewedUid = viewedProfile.id;
const isFriend = friendIdSet.has(viewedUid);
const blockedByMe = blockedByMeUidSet.has(viewedUid);
const blockedMe = blockedMeUidSet.has(viewedUid);

return (
<FriendProfileScreen
profile={viewedProfile}
responses={viewedProfileResponses}
onBack={() => {
setModalScreen(null);
setViewedProfile(null);
setViewedProfileResponses([]);
}}
isFriend={isFriend}
blockedByMe={blockedByMe}
blockedMe={blockedMe}
onRemoveFriend={handleRemoveFriend}
onBlockUser={handleBlockUser}
onUnblockUser={handleUnblockUser}
onReplay={handleReplayEvent}
onReportResponse={handleReportResponse}
/>
);
}

return (
<SafeAreaView style={styles.safeArea}>
<StatusBar style="light" />
<View style={styles.mainShell}>
<View style={styles.topBar}>
<Text style={styles.shellTitle}>OneTake</Text>
<Text style={styles.shellMeta}>@{profile?.usernameLower || 'unset'}</Text>
</View>

<View style={styles.contentArea}>
{tab === 'feed' ? (
<FeedScreen
sections={feedSections}
myReactionMap={myReactionMap}
onReact={handleReaction}
currentUid={user.uid}
onReplay={handleReplayEvent}
onViewResponse={handleViewResponse}
onReportResponse={handleReportResponse}
onBlockResponseUser={handleBlockResponseUser}
/>
) : null}

{tab === 'prompts' ? (
<PromptsScreen
promptRecipients={promptRecipients}
onOpenPrompt={openPrompt}
onSubmitSuggestion={handleSuggestionSubmit}
suggestionBusy={suggestionBusy}
/>
) : null}

{tab === 'friends' ? (
<FriendsScreen
friends={visibleFriends}
incoming={visibleIncomingRequests}
outgoing={visibleOutgoingRequests}
onAccept={handleAcceptRequest}
onDecline={handleDeclineRequest}
onCancel={handleCancelRequest}
onSearch={handleSearch}
searchResults={searchResults}
searchValue={searchValue}
setSearchValue={setSearchValue}
onSendRequest={requestFriend}
onOpenProfile={handleOpenUserProfile}
currentUid={user.uid}
friendIdSet={friendIdSet}
incomingRequestUidSet={incomingRequestUidSet}
outgoingRequestUidSet={outgoingRequestUidSet}
/>
) : null}

{tab === 'profile' ? (
<ProfileScreen
user={user}
profile={profile}
myResponses={myResponses}
onDeleteResponse={handleDeleteResponse}
onDeleteAccount={handleDeleteAccount}
onSignOut={handleSignOut}
onOpenAdmin={() => setModalScreen('admin')}
onReplay={handleReplayEvent}
/>
) : null}
</View>

<View style={styles.tabBar}>
{TABS.map((tabKey) => (
<TouchableOpacity key={tabKey} style={styles.tabButton} onPress={() => setTab(tabKey)}>
<Text style={[styles.tabLabel, tab === tabKey ? styles.tabLabelActive : null]}>{tabKey}</Text>
</TouchableOpacity>
))}
</View>
</View>
</SafeAreaView>
);
}

const styles = StyleSheet.create({
safeArea: { flex: 1, backgroundColor: '#0B0F1A' },
centeredContainer: {
flex: 1,
paddingHorizontal: 24,
alignItems: 'center',
justifyContent: 'center',
},
authPageContent: {
padding: 24,
gap: 14,
paddingTop: 72,
paddingBottom: 72,
},
pageContent: {
padding: 20,
gap: 12,
paddingBottom: 120,
},
mainShell: { flex: 1 },
topBar: {
paddingHorizontal: 20,
paddingTop: 8,
paddingBottom: 12,
borderBottomWidth: 1,
borderBottomColor: '#1B2332',
},
shellTitle: { color: '#fff', fontSize: 28, fontWeight: '800' },
shellMeta: { color: '#8BA0BE', marginTop: 4 },
contentArea: { flex: 1 },
headerRow: {
flexDirection: 'row',
alignItems: 'center',
gap: 12,
marginBottom: 8,
},
headerTitle: { color: '#FFFFFF', fontSize: 28, fontWeight: '800' },
headerSubtitle: { color: '#8BA0BE', marginTop: 4, lineHeight: 20 },
appTitle: { color: '#fff', fontSize: 46, fontWeight: '900', textAlign: 'center' },
tagline: { color: '#C7D3EA', fontSize: 16, textAlign: 'center', marginTop: 8, marginBottom: 24 },
authInputStack: {
width: '100%',
gap: 12,
},
authInput: {
width: '100%',
},
authPrimaryButtonWrap: {
width: '100%',
marginTop: 14,
},
card: {
backgroundColor: '#121826',
borderWidth: 1,
borderColor: '#1B2332',
borderRadius: 18,
padding: 16,
gap: 8,
},
explainerCard: {
backgroundColor: '#151C2A',
borderColor: '#2A3347',
},
explainerTitle: {
color: '#FFFFFF',
fontSize: 18,
fontWeight: '800',
lineHeight: 24,
},
explainerBody: {
color: '#D7E2F2',
lineHeight: 21,
},
explainerBulletWrap: {
gap: 6,
marginTop: 4,
},
explainerBullet: {
color: '#B8CAE3',
lineHeight: 20,
},
moderationNoticeCard: {
backgroundColor: '#151C2A',
borderColor: '#2A3347',
},
moderationActionRow: {
gap: 8,
marginTop: 4,
},
feedPromptCard: {
paddingBottom: 14,
},
cardTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', lineHeight: 24 },
bodyCopy: { color: '#C7D3EA', lineHeight: 22 },
metaText: { color: '#7F93AF', fontSize: 12 },
valueText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
sectionLabel: { color: '#AFC1DD', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', marginTop: 10 },
label: { color: '#8BA0BE', fontSize: 12, textTransform: 'uppercase' },
input: {
backgroundColor: '#121826',
borderRadius: 16,
borderWidth: 1,
borderColor: '#1B2332',
paddingHorizontal: 14,
paddingVertical: 14,
color: '#FFFFFF',
},
multilineInput: { minHeight: 110, textAlignVertical: 'top' },
button: {
borderRadius: 16,
paddingHorizontal: 16,
paddingVertical: 14,
alignItems: 'center',
justifyContent: 'center',
},
buttonPrimary: { backgroundColor: '#5B5CF0' },
buttonSecondary: { backgroundColor: '#151C2A', borderWidth: 1, borderColor: '#2A3347' },
buttonDanger: { backgroundColor: '#9D2B2B' },
buttonDisabled: { opacity: 0.55 },
buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
footnote: { color: '#5C708C', fontSize: 12, marginTop: 12 },
countdownLabel: { color: '#AFC1DD', marginBottom: 10 },
countdownNumber: { color: '#FFFFFF', fontSize: 72, fontWeight: '900' },
countdownOverlay: {
position: 'absolute',
left: 16,
right: 16,
top: Platform.OS === 'ios' ? 64 : 32,
bottom: 24,
justifyContent: 'center',
alignItems: 'center',
backgroundColor: 'rgba(9,11,17,0.42)',
borderRadius: 24,
paddingHorizontal: 20,
gap: 12,
},
countdownPromptText: {
color: '#FFFFFF',
fontSize: 22,
fontWeight: '800',
lineHeight: 30,
textAlign: 'center',
},
cameraScreen: { flex: 1, backgroundColor: '#000' },
cameraPreview: { flex: 1 },
cameraOverlay: {
position: 'absolute',
left: 0,
right: 0,
bottom: 0,
padding: 20,
backgroundColor: 'rgba(9,11,17,0.88)',
gap: 10,
},
cameraTitle: { color: '#fff', fontSize: 24, fontWeight: '800' },
cameraSubtitle: { color: '#C7D3EA', lineHeight: 20 },
cameraTimer: { color: '#FFFFFF', fontSize: 30, fontWeight: '800' },
errorInline: { color: '#FCA5A5', lineHeight: 20, textAlign: 'center' },
videoWrap: {
height: 300,
borderRadius: 18,
overflow: 'hidden',
backgroundColor: '#000',
borderWidth: 1,
borderColor: '#1B2332',
},
tallVideoWrap: {
height: 250,
},
feedVideoWrap: {
height: 250,
borderRadius: 16,
overflow: 'hidden',
backgroundColor: '#000',
borderWidth: 1,
borderColor: '#1B2332',
marginTop: 4,
marginBottom: 2,
},
profileVideoWrap: {
height: 260,
borderRadius: 16,
overflow: 'hidden',
backgroundColor: '#000',
borderWidth: 1,
borderColor: '#1B2332',
marginTop: 4,
},
video: { width: '100%', height: '100%' },
replayOverlay: {
...StyleSheet.absoluteFillObject,
backgroundColor: 'rgba(0,0,0,0.45)',
alignItems: 'center',
justifyContent: 'center',
},
replayOverlayText: {
color: '#FFFFFF',
fontWeight: '800',
fontSize: 15,
backgroundColor: 'rgba(11,15,26,0.82)',
paddingHorizontal: 14,
paddingVertical: 10,
borderRadius: 999,
},
responseRailList: {
paddingTop: 12,
paddingRight: 4,
},
responseRailCard: {
width: 290,
marginRight: 12,
backgroundColor: '#0E1420',
borderWidth: 1,
borderColor: '#1B2332',
borderRadius: 18,
padding: 10,
gap: 8,
},
responseIdentityRow: {
flexDirection: 'row',
alignItems: 'center',
gap: 8,
paddingHorizontal: 2,
},
responseHandleLarge: {
color: '#FFFFFF',
fontWeight: '700',
fontSize: 15,
lineHeight: 20,
},
youPill: {
backgroundColor: '#1C2640',
borderWidth: 1,
borderColor: '#33415D',
borderRadius: 999,
paddingHorizontal: 8,
paddingVertical: 3,
},
youPillText: {
color: '#C7D3EA',
fontSize: 11,
fontWeight: '700',
},
  reactionScroll: {
    maxHeight: 44,
    flexGrow: 0,
  },
  reactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 6,
    paddingBottom: 2,
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#29354A',
    backgroundColor: '#151C2A',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    minHeight: 34,
    maxHeight: 38,
  },
  reactionChipActive: {
    backgroundColor: '#2A2C7D',
    borderColor: '#5B5CF0',
  },
  reactionChipText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
    textTransform: 'capitalize',
  },
  reactionChipCount: {
    color: '#9BB2D1',
    fontSize: 13,
    fontWeight: '600',
  },
tabButton: { flex: 1, alignItems: 'center' },
tabLabel: { color: '#667A97', fontWeight: '700', textTransform: 'capitalize' },
tabLabelActive: { color: '#FFFFFF' },
userRow: {
flexDirection: 'row',
alignItems: 'center',
gap: 12,
paddingVertical: 8,
},
rowGap: { gap: 10 },
});