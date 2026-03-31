import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Video, ResizeMode } from 'expo-av';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Platform,
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
import { uploadVideoForResponse } from '../lib/storage';
import {
  enableAdminForUser,
  ensureUserProfile,
  isProfileComplete,
  saveProfileSetup,
  searchUsersByUsername,
  subscribeToProfile,
} from '../services/profileService';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  sendFriendRequest,
  subscribeToFriendships,
  subscribeToIncomingRequests,
  subscribeToOutgoingRequests,
} from '../services/friendsService';
import {
  createPromptTemplate,
  issueGlobalPrompt,
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
  subscribeUserResponses,
} from '../services/responsesService';
import { REACTION_TYPES, subscribeMyReactions, toggleReaction } from '../services/reactionsService';
import { reviewPromptSuggestion, submitPromptSuggestion, subscribePromptSuggestions } from '../services/promptSuggestionsService';

const APP_VERSION = 'OneTake rebuild alpha';
const TABS = ['feed', 'prompts', 'friends', 'profile'];

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
  return 'New OneTake ready';
}

function getPromptStateLabel(recipient) {
  switch (recipient.computedStatus) {
    case 'responded':
      return 'Submitted';
    case 'forfeited':
      return 'Forfeited';
    case 'expired':
      return 'Expired';
    case 'opened':
    case 'recording_started':
      return 'Attempt used';
    default:
      return 'Ready';
  }
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

function AuthScreen({ authMode, setAuthMode, email, setEmail, password, setPassword, busy, onSubmit }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.centeredContainer}>
        <Text style={styles.appTitle}>OneTake</Text>
        <Text style={styles.tagline}>One prompt. One reveal. One take.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#7C8BA1"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#7C8BA1"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <PrimaryButton
          label={busy ? 'Working…' : authMode === 'signup' ? 'Create Account' : 'Sign In'}
          onPress={onSubmit}
          disabled={busy}
        />
        <PrimaryButton
          label={authMode === 'signup' ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
          onPress={() => setAuthMode(authMode === 'signup' ? 'signin' : 'signup')}
          quiet
        />
        <Text style={styles.footnote}>{APP_VERSION}</Text>
      </View>
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
        <PrimaryButton label={busy ? 'Saving…' : 'Enter OneTake'} onPress={() => onSave({ username, displayName, bio })} disabled={busy} />
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
          <Text style={styles.cardTitle}>Once you open this prompt, your attempt starts.</Text>
          <Text style={styles.bodyCopy}>If you back out after viewing it, it counts as a forfeit.</Text>
          <Text style={styles.bodyCopy}>No retakes. No second opens.</Text>
          <Text style={styles.bodyCopy}>You’ll have 10 seconds before recording begins.</Text>
        </Card>
        <PrimaryButton label="Open Prompt" onPress={onOpen} />
        <PrimaryButton label="Not Now" onPress={onBack} quiet />
      </View>
    </SafeAreaView>
  );
}

function RevealScreen({ recipient, countdown, onForfeit }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.pageContent}>
        <ScreenHeader title="Your OneTake prompt" subtitle="Backing out now counts as a private forfeit." />
        <Card style={styles.promptHero}>
          <Text style={styles.promptHeroText}>{recipient.promptTextSnapshot}</Text>
        </Card>
        <View style={styles.countdownWrap}>
          <Text style={styles.countdownLabel}>Recording starts in</Text>
          <Text style={styles.countdownNumber}>{countdown}</Text>
        </View>
        <PrimaryButton label="Forfeit" onPress={onForfeit} danger />
      </View>
    </SafeAreaView>
  );
}

function RecordScreen({ recipient, onComplete, onForfeit }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const cameraRef = useRef(null);

  useEffect(() => {
    let interval;
    if (recording) {
      interval = setInterval(() => setSeconds((value) => value + 1), 1000);
    }
    return () => interval && clearInterval(interval);
  }, [recording]);

  useEffect(() => {
    let cancelled = false;
    async function begin() {
      try {
        if (!permission?.granted) {
          const result = await requestPermission();
          if (!result.granted) {
            setError('Camera permission is required to record your OneTake.');
            return;
          }
        }

        setTimeout(async () => {
          if (cancelled || !cameraRef.current) return;
          try {
            setRecording(true);
            const video = await cameraRef.current.recordAsync({ maxDuration: 30 });
            setRecording(false);
            if (!video?.uri) {
              onForfeit();
              return;
            }
            onComplete({
              localUri: video.uri,
              durationSeconds: Math.min(seconds || 30, 30),
            });
          } catch (err) {
            setRecording(false);
            setError(err?.message || 'Recording failed.');
          }
        }, 500);
      } catch (err) {
        setError(err?.message || 'Unable to access camera.');
      }
    }
    begin();
    return () => {
      cancelled = true;
      try {
        cameraRef.current?.stopRecording?.();
      } catch {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.cameraScreen}>
      <StatusBar style="light" />
      <CameraView ref={cameraRef} style={styles.cameraPreview} facing="front" mode="video" />
      <View style={styles.cameraOverlay}>
        <Text style={styles.cameraTitle}>Recording now</Text>
        <Text style={styles.cameraSubtitle}>{recipient.promptTextSnapshot}</Text>
        <Text style={styles.cameraTimer}>{recording ? `${seconds}s` : 'Preparing camera…'}</Text>
        {error ? <Text style={styles.errorInline}>{error}</Text> : null}
        <PrimaryButton label={recording ? 'Stop early' : 'Forfeit'} onPress={recording ? () => cameraRef.current?.stopRecording?.() : onForfeit} danger />
      </View>
    </View>
  );
}

function ReviewScreen({ localUri, durationSeconds, uploadBusy, uploadError, onSubmit, onForfeit }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.pageContent}>
        <ScreenHeader title="Review your take" subtitle="This is your only take. Submit it or forfeit." />
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

function FeedScreen({ sections, myReactionMap, onReact, currentUid }) {
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <ScreenHeader title="Feed" subtitle="Shared prompt rails from you and your friends." />
      {sections.length === 0 ? (
        <Card>
          <Text style={styles.bodyCopy}>No shared replies yet. Get a prompt out, add friends, and the rails will start filling up.</Text>
        </Card>
      ) : (
        sections.map((section) => (
          <Card key={section.promptId} style={{ marginBottom: 16 }}>
            <Text style={styles.cardTitle}>{section.promptText}</Text>
            <Text style={styles.metaText}>{formatTime(section.issuedAtClient)}</Text>
            <Text style={styles.metaText}>{section.responses.length} visible response{section.responses.length === 1 ? '' : 's'}</Text>
            <FlatList
              data={section.responses}
              horizontal
              keyExtractor={(item) => item.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingTop: 12 }}
              renderItem={({ item }) => (
                <View style={styles.responseRailCard}>
                  <Text style={styles.responseAuthor}>
                    {item.authorDisplayNameSnapshot} {item.uid === currentUid ? '• You' : ''}
                  </Text>
                  <Text style={styles.responseHandle}>@{item.authorUsernameSnapshot || 'user'}</Text>
                  <View style={styles.smallVideoWrap}>
                    <Video
                      style={styles.video}
                      source={{ uri: item.videoUrl }}
                      useNativeControls
                      resizeMode={ResizeMode.CONTAIN}
                      isLooping={false}
                    />
                  </View>
                  <Text style={styles.metaText}>{formatTime(item.createdAtClient)}</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 8 }}>
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
  const active = promptRecipients.filter((item) => item.computedStatus === 'sent' && item.expiresAtClient > Date.now());
  const history = promptRecipients.filter((item) => !active.find((entry) => entry.id === item.id));

  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <ScreenHeader title="Prompts" subtitle="Your personal prompt inbox and history." />

      <Text style={styles.sectionLabel}>Active</Text>
      {active.length === 0 ? (
        <Card><Text style={styles.bodyCopy}>No active prompts right now.</Text></Card>
      ) : (
        active.map((recipient) => (
          <Card key={recipient.id}>
            <Text style={styles.cardTitle}>{maskPromptPreview(recipient)}</Text>
            <Text style={styles.metaText}>{timeLeftLabel(recipient.expiresAtClient)}</Text>
            <Text style={styles.metaText}>{getPromptStateLabel(recipient)}</Text>
            <PrimaryButton label="Open" onPress={() => onOpenPrompt(recipient)} />
          </Card>
        ))
      )}

      <Text style={styles.sectionLabel}>History</Text>
      {history.length === 0 ? (
        <Card><Text style={styles.bodyCopy}>No history yet.</Text></Card>
      ) : (
        history.map((recipient) => (
          <Card key={recipient.id}>
            <Text style={styles.cardTitle}>{maskPromptPreview(recipient)}</Text>
            <Text style={styles.metaText}>{getPromptStateLabel(recipient)}</Text>
            <Text style={styles.metaText}>{formatTime(recipient.startAtClient)}</Text>
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
  currentUid,
}) {
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <ScreenHeader title="Friends" subtitle="Add people so your reply rails start to matter." />
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
            <View key={result.id} style={styles.userRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{result.displayName || result.email || result.id}</Text>
                <Text style={styles.metaText}>@{result.usernameLower || 'unset'}</Text>
              </View>
              {result.id !== currentUid ? <PrimaryButton label="Add" onPress={() => onSendRequest(result.id)} /> : null}
            </View>
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
          <Card key={friend.id}>
            <Text style={styles.cardTitle}>{friend.user.displayName || friend.user.email}</Text>
            <Text style={styles.metaText}>@{friend.user.usernameLower || 'unset'}</Text>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

function ProfileScreen({ user, profile, myResponses, onDeleteResponse, onSignOut, onEnableAdmin, onOpenAdmin }) {
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
      ) : (
        <PrimaryButton label="Enable admin tools (dev)" onPress={onEnableAdmin} quiet />
      )}

      <Text style={styles.sectionLabel}>My submitted responses</Text>
      {myResponses.length === 0 ? (
        <Card><Text style={styles.bodyCopy}>You haven’t submitted any OneTakes yet.</Text></Card>
      ) : (
        myResponses.map((response) => (
          <Card key={response.id}>
            <Text style={styles.cardTitle}>{response.promptTextSnapshot}</Text>
            <Text style={styles.metaText}>{formatTime(response.createdAtClient)}</Text>
            <View style={styles.smallVideoWrap}>
              <Video
                style={styles.video}
                source={{ uri: response.videoUrl }}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
              />
            </View>
            <PrimaryButton label="Delete response" onPress={() => onDeleteResponse(response.id)} quiet danger />
          </Card>
        ))
      )}

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
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.pageContent}>
        <ScreenHeader title="Admin tools" subtitle="Create prompt bank entries and launch a prompt for everyone." right={<PrimaryButton label="Close" onPress={onClose} quiet />} />
        <TextInput
          style={[styles.input, styles.multilineInput]}
          placeholder="New prompt template text"
          placeholderTextColor="#7C8BA1"
          multiline
          value={newTemplateText}
          onChangeText={setNewTemplateText}
        />
        <PrimaryButton label="Create template" onPress={onCreateTemplate} disabled={!newTemplateText.trim()} />

        <Text style={styles.sectionLabel}>Prompt bank</Text>
        {templates.length === 0 ? (
          <Card><Text style={styles.bodyCopy}>No templates yet.</Text></Card>
        ) : (
          templates.map((template) => (
            <Card key={template.id}>
              <Text style={styles.cardTitle}>{template.text}</Text>
              <Text style={styles.metaText}>{formatTime(template.createdAtClient)}</Text>
              <PrimaryButton label="Issue to all users" onPress={() => onIssueTemplate(template)} />
            </Card>
          ))
        )}

        <Text style={styles.sectionLabel}>Pending suggestions</Text>
        {suggestions.filter((item) => item.status === 'pending').length === 0 ? (
          <Card><Text style={styles.bodyCopy}>No pending suggestions.</Text></Card>
        ) : (
          suggestions.filter((item) => item.status === 'pending').map((item) => (
            <Card key={item.id}>
              <Text style={styles.cardTitle}>{item.text}</Text>
              <Text style={styles.metaText}>Submitted by {item.submittedByUid}</Text>
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
  const [tab, setTab] = useState('feed');
  const [friends, setFriends] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [outgoingRequests, setOutgoingRequests] = useState([]);
  const [promptRecipients, setPromptRecipients] = useState([]);
  const [feedResponses, setFeedResponses] = useState([]);
  const [myResponses, setMyResponses] = useState([]);
  const [myReactionMap, setMyReactionMap] = useState({});
  const [searchValue, setSearchValue] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [modalScreen, setModalScreen] = useState(null); // commit | reveal | record | review | admin
  const [activeRecipient, setActiveRecipient] = useState(null);
  const [countdown, setCountdown] = useState(10);
  const [reviewTake, setReviewTake] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [newTemplateText, setNewTemplateText] = useState('');
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser || null);
      setAuthLoading(false);
      if (currentUser) await ensureUserProfile(currentUser);
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
      subscribeToPromptRecipients(user.uid, setPromptRecipients, () => {}),
      subscribeUserResponses(user.uid, setMyResponses, () => {}),
      subscribeMyReactions(user.uid, setMyReactionMap, () => {}),
    ];
    return () => unsubs.forEach((unsub) => unsub && unsub());
  }, [user?.uid, profile?.usernameLower]);

  useEffect(() => {
    if (!user?.uid || !isProfileComplete(profile)) return;
    const visibleIds = [user.uid, ...friends.map((item) => item.user?.id).filter(Boolean)];
    return subscribeFeedResponses(visibleIds, setFeedResponses, () => {});
  }, [user?.uid, profile?.usernameLower, friends]);

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
          if (activeRecipient?.id) markRecordingStarted(activeRecipient.id).catch(() => {});
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [modalScreen, activeRecipient?.id]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState) => {
      const previous = appStateRef.current;
      appStateRef.current = nextState;
      if (previous === 'active' && nextState.match(/inactive|background/)) {
        if ((modalScreen === 'reveal' || modalScreen === 'record') && activeRecipient) {
          try {
            await markPromptForfeited(activeRecipient);
          } catch {}
          setActiveRecipient(null);
          setModalScreen(null);
          setReviewTake(null);
        }
      }
    });
    return () => sub.remove();
  }, [modalScreen, activeRecipient]);

  const feedSections = useMemo(() => chunkPromptSections(feedResponses), [feedResponses]);

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
        await createUserWithEmailAndPassword(auth, email.trim(), password.trim());
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password.trim());
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
      await saveProfileSetup({
        uid: user.uid,
        email: user.email,
        username,
        displayName,
        bio,
      });
    } catch (err) {
      Alert.alert('Profile error', err?.message || String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const openPrompt = (recipient) => {
    if (recipient.computedStatus !== 'sent') {
      Alert.alert('Not available', 'That prompt can no longer be opened.');
      return;
    }
    if (recipient.expiresAtClient < Date.now()) {
      Alert.alert('Expired', 'That prompt has expired.');
      return;
    }
    setActiveRecipient(recipient);
    setModalScreen('commit');
  };

  const handleCommitOpen = async () => {
    try {
      await markPromptOpened(activeRecipient);
      setActiveRecipient({ ...activeRecipient, computedStatus: 'opened' });
      setModalScreen('reveal');
    } catch (err) {
      Alert.alert('Prompt error', err?.message || String(err));
    }
  };

  const doForfeitActiveRecipient = async () => {
    try {
      if (activeRecipient) await markPromptForfeited(activeRecipient);
    } catch (err) {
      Alert.alert('Forfeit error', err?.message || String(err));
    } finally {
      setModalScreen(null);
      setActiveRecipient(null);
      setReviewTake(null);
      setUploadError('');
    }
  };

  const handleRecordComplete = ({ localUri, durationSeconds }) => {
    setReviewTake({ localUri, durationSeconds });
    setModalScreen('review');
  };

  const handleSubmitReview = async () => {
    if (!reviewTake?.localUri || !activeRecipient || !profile) return;
    setUploadBusy(true);
    setUploadError('');
    try {
      const responseId = activeRecipient.id;
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
      setModalScreen(null);
      setActiveRecipient(null);
      setReviewTake(null);
      setTab('feed');
    } catch (err) {
      setUploadError(err?.message || String(err));
    } finally {
      setUploadBusy(false);
    }
  };

  const handleSearch = async () => {
    setSearchBusy(true);
    try {
      const results = await searchUsersByUsername(searchValue);
      const blockedIds = new Set([user.uid]);
      setSearchResults(results.filter((item) => !blockedIds.has(item.id)));
    } catch (err) {
      Alert.alert('Search error', err?.message || String(err));
    } finally {
      setSearchBusy(false);
    }
  };

  const requestFriend = async (targetUid) => {
    try {
      await sendFriendRequest(user.uid, targetUid);
      Alert.alert('Sent', 'Friend request sent.');
      handleSearch();
    } catch (err) {
      Alert.alert('Friend request', err?.message || String(err));
    }
  };

  const handleCreateTemplate = async () => {
    try {
      await createPromptTemplate(newTemplateText, user.uid);
      setNewTemplateText('');
    } catch (err) {
      Alert.alert('Template error', err?.message || String(err));
    }
  };

  const handleIssueTemplate = async (template) => {
    try {
      await issueGlobalPrompt({ promptTemplateId: template.id, text: template.text, adminUid: user.uid });
      Alert.alert('Prompt issued', 'The prompt is now live for all users.');
    } catch (err) {
      Alert.alert('Issue error', err?.message || String(err));
    }
  };

  const handleSuggestionSubmit = async (text) => {
    if (!text?.trim()) return;
    setSuggestionBusy(true);
    try {
      await submitPromptSuggestion(text.trim(), user.uid);
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
          } catch (err) {
            Alert.alert('Delete error', err?.message || String(err));
          }
        },
      },
    ]);
  };

  const handleReviewSuggestion = async (suggestion, status) => {
    try {
      await reviewPromptSuggestion({ suggestionId: suggestion.id, adminUid: user.uid, status });
      if (status === 'approved') {
        await createPromptTemplate(suggestion.text, user.uid, suggestion.submittedByUid || null);
      }
      Alert.alert('Updated', `Suggestion ${status}.`);
    } catch (err) {
      Alert.alert('Review error', err?.message || String(err));
    }
  };

  const handleEnableAdmin = async () => {
    try {
      await enableAdminForUser(user.uid);
      Alert.alert('Admin enabled', 'Dev admin tools are now available on this account.');
    } catch (err) {
      Alert.alert('Admin error', err?.message || String(err));
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setTab('feed');
      setModalScreen(null);
      setActiveRecipient(null);
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

  if (modalScreen === 'commit' && activeRecipient) {
    return <CommitScreen recipient={activeRecipient} onBack={() => setModalScreen(null)} onOpen={handleCommitOpen} />;
  }

  if (modalScreen === 'reveal' && activeRecipient) {
    return <RevealScreen recipient={activeRecipient} countdown={countdown} onForfeit={doForfeitActiveRecipient} />;
  }

  if (modalScreen === 'record' && activeRecipient) {
    return <RecordScreen recipient={activeRecipient} onComplete={handleRecordComplete} onForfeit={doForfeitActiveRecipient} />;
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.mainShell}>
        <View style={styles.topBar}>
          <Text style={styles.shellTitle}>OneTake</Text>
          <Text style={styles.shellMeta}>@{profile?.usernameLower || 'unset'}</Text>
        </View>

        <View style={styles.contentArea}>
          {tab === 'feed' ? <FeedScreen sections={feedSections} myReactionMap={myReactionMap} onReact={handleReaction} currentUid={user.uid} /> : null}
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
              friends={friends}
              incoming={incomingRequests}
              outgoing={outgoingRequests}
              onAccept={acceptFriendRequest}
              onDecline={declineFriendRequest}
              onCancel={cancelFriendRequest}
              onSearch={handleSearch}
              searchResults={searchResults}
              searchValue={searchValue}
              setSearchValue={setSearchValue}
              onSendRequest={requestFriend}
              currentUid={user.uid}
            />
          ) : null}
          {tab === 'profile' ? (
            <ProfileScreen
              user={user}
              profile={profile}
              myResponses={myResponses}
              onDeleteResponse={handleDeleteResponse}
              onSignOut={handleSignOut}
              onEnableAdmin={handleEnableAdmin}
              onOpenAdmin={() => setModalScreen('admin')}
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
  card: {
    backgroundColor: '#121826',
    borderWidth: 1,
    borderColor: '#1B2332',
    borderRadius: 18,
    padding: 16,
    gap: 8,
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
  promptHero: { paddingVertical: 30, backgroundColor: '#171F30' },
  promptHeroText: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', lineHeight: 32 },
  countdownWrap: { alignItems: 'center', paddingVertical: 16 },
  countdownLabel: { color: '#AFC1DD', marginBottom: 10 },
  countdownNumber: { color: '#FFFFFF', fontSize: 72, fontWeight: '900' },
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
  errorInline: { color: '#FCA5A5', lineHeight: 20 },
  videoWrap: {
    height: 300,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#1B2332',
  },
  smallVideoWrap: {
    height: 160,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#1B2332',
    marginTop: 8,
  },
  video: { width: '100%', height: '100%' },
  responseRailCard: {
    width: 260,
    marginRight: 12,
    backgroundColor: '#0E1420',
    borderWidth: 1,
    borderColor: '#1B2332',
    borderRadius: 18,
    padding: 12,
  },
  responseAuthor: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  responseHandle: { color: '#7F93AF', marginTop: 2, marginBottom: 6 },
  reactionChip: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#29354A',
    backgroundColor: '#151C2A',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
  },
  reactionChipActive: {
    backgroundColor: '#2A2C7D',
    borderColor: '#5B5CF0',
  },
  reactionChipText: { color: '#FFFFFF', fontWeight: '600', textTransform: 'capitalize' },
  reactionChipCount: { color: '#9BB2D1', fontSize: 12 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#1B2332',
    paddingBottom: Platform.OS === 'ios' ? 22 : 12,
    paddingTop: 12,
    backgroundColor: '#0B0F1A',
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
