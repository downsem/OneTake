import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Video, ResizeMode } from 'expo-av';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { auth } from './src/lib/firebase';
import { uploadVideoForUser } from './src/lib/storage';
import { createTake, deleteTake, subscribeToUserTakes } from './src/services/takesService';

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';

const APP_VERSION = 'MVP v1.0';

export default function App() {
  const [screen, setScreen] = useState('home'); // home | camera | takes | takeDetail | settings
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [authMode, setAuthMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  const [takes, setTakes] = useState([]);
  const [takesLoading, setTakesLoading] = useState(false);
  const [selectedTake, setSelectedTake] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser || null);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setTakes([]);
      return;
    }

    setTakesLoading(true);
    const unsub = subscribeToUserTakes(
      user.uid,
      (items) => {
        setTakes(items);
        setTakesLoading(false);
      },
      (err) => {
        setTakesLoading(false);
        Alert.alert('Firestore error', err.message || String(err));
      }
    );

    return unsub;
  }, [user?.uid]);

  const handleAuthSubmit = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing fields', 'Please enter email and password.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Password too short', 'Use at least 6 characters.');
      return;
    }

    setAuthBusy(true);
    try {
      if (authMode === 'signup') {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
      setPassword('');
      setScreen('home');
    } catch (err) {
      Alert.alert('Auth error', err?.message || String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setScreen('home');
      setSelectedTake(null);
    } catch (err) {
      Alert.alert('Sign out error', err?.message || String(err));
    }
  };

  const saveTakeDoc = async ({ localUri, source, downloadURL = '', storagePath = '' }) => {
    if (!user?.uid) {
      Alert.alert('Sign in required', 'Please sign in to save takes.');
      return;
    }
    await createTake(user.uid, { localUri, source, downloadURL, storagePath });
  };

  const doDeleteTake = async (take) => {
    if (!user?.uid || !take?.id) return;
    setDeleteBusy(true);
    try {
      await deleteTake(user.uid, take.id);
      Alert.alert('Deleted', 'Take removed from Firestore.');
      setScreen('takes');
      setSelectedTake(null);
    } catch (err) {
      Alert.alert('Delete error', err?.message || String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmDeleteTake = (take) => {
    if (Platform.OS === 'web') {
      const ok = window.confirm('Delete this take?');
      if (ok) doDeleteTake(take);
      return;
    }
    Alert.alert('Delete take?', 'This removes metadata from Firestore.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => doDeleteTake(take) },
    ]);
  };

  const openCamera = async () => {
    if (!user?.uid) {
      Alert.alert('Sign in first', 'Create an account or sign in before recording.');
      return;
    }
    if (Platform.OS === 'web') {
      setScreen('camera');
      return;
    }

    if (!permission) {
      Alert.alert('Please wait', 'Checking camera permission...');
      return;
    }
    if (!permission.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert('Camera access needed', 'Please allow camera permission.');
        return;
      }
    }
    setScreen('camera');
  };

  const startRecording = async () => {
    if (Platform.OS === 'web') {
      setIsRecording(true);
      setTimeout(async () => {
        try {
          await saveTakeDoc({
            localUri: `web-demo://take-${Date.now()}`,
            source: 'web-demo',
          });
          Alert.alert('Take saved', 'Web demo take saved.');
        } catch (err) {
          Alert.alert('Save error', err?.message || String(err));
        } finally {
          setIsRecording(false);
          setScreen('home');
        }
      }, 700);
      return;
    }

    try {
      if (!cameraRef.current) {
        Alert.alert('Camera not ready', 'Please wait a second and try again.');
        return;
      }

      setIsRecording(true);
      const video = await cameraRef.current.recordAsync({ maxDuration: 30 });

      if (!video?.uri) {
        Alert.alert('No video captured', 'Please try again.');
        return;
      }

      const { storagePath, downloadURL } = await uploadVideoForUser({
        userId: user.uid,
        localUri: video.uri,
      });

      await saveTakeDoc({
        localUri: video.uri,
        source: 'camera',
        downloadURL,
        storagePath,
      });

      Alert.alert('Take saved', 'Video uploaded and saved.');
      setScreen('home');
    } catch (error) {
      Alert.alert('Recording/upload error', String(error?.message || error));
    } finally {
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (Platform.OS === 'web') return;
    try {
      if (cameraRef.current && isRecording) cameraRef.current.stopRecording();
    } catch (error) {
      Alert.alert('Stop error', String(error?.message || error));
    }
  };

  const formatDate = (iso) => {
    if (!iso) return 'Saving...';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const takeCountLabel = useMemo(() => {
    if (takes.length === 0) return 'No takes yet';
    if (takes.length === 1) return '1 take saved';
    return `${takes.length} takes saved`;
  }, [takes.length]);

  if (authLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.infoText}>Loading account...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.container}>
          <Text style={styles.title}>OneTake</Text>
          <Text style={styles.subtitle}>
            {authMode === 'signup'
              ? 'Create your account to start saving takes.'
              : 'Sign in to access your takes.'}
          </Text>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#94A3B8"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />

          <TextInput
            style={styles.input}
            placeholder="Password (min 6 chars)"
            placeholderTextColor="#94A3B8"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <TouchableOpacity style={styles.primaryButton} onPress={handleAuthSubmit} disabled={authBusy}>
            <Text style={styles.primaryButtonText}>
              {authBusy ? 'Please wait...' : authMode === 'signup' ? 'Create Account' : 'Sign In'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => setAuthMode((m) => (m === 'signin' ? 'signup' : 'signin'))}
          >
            <Text style={styles.secondaryButtonText}>
              {authMode === 'signin'
                ? 'Need an account? Sign up'
                : 'Already have an account? Sign in'}
            </Text>
          </TouchableOpacity>

          <Text style={styles.versionText}>{APP_VERSION}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'camera') {
    const isWeb = Platform.OS === 'web';

    return (
      <View style={styles.cameraScreen}>
        <StatusBar style="light" />
        {isWeb ? (
          <View style={styles.webCameraPlaceholder}>
            <Text style={styles.webCameraTitle}>Web Demo Mode</Text>
            <Text style={styles.webCameraText}>In web/Codespaces, we save a demo take.</Text>
          </View>
        ) : (
          <CameraView ref={cameraRef} style={styles.cameraPreview} facing="back" mode="video" />
        )}

        <View style={styles.cameraOverlay}>
          <Text style={styles.cameraTitle}>OneTake Camera</Text>
          <Text style={styles.cameraSubtitle}>
            {isWeb
              ? 'Start = save demo take'
              : isRecording
              ? 'Recording... tap Stop when done'
              : 'Tap Start to record your one take'}
          </Text>

          {!isRecording ? (
            <TouchableOpacity style={styles.primaryButton} onPress={startRecording}>
              <Text style={styles.primaryButtonText}>
                {isWeb ? 'Start Recording (Web Demo)' : 'Start Recording'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.stopButton} onPress={stopRecording}>
              <Text style={styles.primaryButtonText}>
                {isWeb ? 'Saving Demo Take...' : 'Stop Recording'}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('home')}>
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (screen === 'takeDetail' && selectedTake) {
    const canPlay = !!selectedTake.downloadURL;

    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.container}>
          <Text style={styles.title}>Take Detail</Text>
          <Text style={styles.subtitle}>{formatDate(selectedTake.createdAt)}</Text>

          <View style={styles.takeCard}>
            <Text style={styles.takeMeta}>Source: {selectedTake.source}</Text>
            <Text style={styles.takeUri} numberOfLines={2}>
              localUri: {selectedTake.localUri || '(none)'}
            </Text>
            <Text style={styles.takeUri} numberOfLines={2}>
              downloadURL: {selectedTake.downloadURL || '(none)'}
            </Text>
          </View>

          {canPlay ? (
            <View style={styles.videoWrap}>
              <Video
                style={styles.video}
                source={{ uri: selectedTake.downloadURL }}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                isLooping={false}
              />
            </View>
          ) : (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>
                No playable URL yet (web-demo takes do not upload video files).
              </Text>
            </View>
          )}

          {canPlay && (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => Linking.openURL(selectedTake.downloadURL)}
            >
              <Text style={styles.secondaryButtonText}>Open Video URL</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.deleteButton}
            onPress={() => confirmDeleteTake(selectedTake)}
            disabled={deleteBusy}
          >
            <Text style={styles.deleteButtonText}>{deleteBusy ? 'Deleting...' : 'Delete Take'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('takes')}>
            <Text style={styles.secondaryButtonText}>Back to My Takes</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'takes') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.container}>
          <Text style={styles.title}>My Takes</Text>
          <Text style={styles.subtitle}>{takeCountLabel}</Text>

          {takesLoading ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>Loading takes...</Text>
            </View>
          ) : takes.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No takes yet. Record your first one!</Text>
            </View>
          ) : (
            <FlatList
              data={takes}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item, index }) => (
                <View style={styles.takeCard}>
                  <Text style={styles.takeTitle}>Take #{takes.length - index}</Text>
                  <Text style={styles.takeMeta}>{formatDate(item.createdAt)}</Text>
                  <Text style={styles.takeMeta}>Source: {item.source}</Text>
                  <Text style={styles.takeUri} numberOfLines={1}>
                    downloadURL: {item.downloadURL ? 'available ✅' : 'not available'}
                  </Text>

                  <View style={styles.row}>
                    <TouchableOpacity
                      style={styles.smallButton}
                      onPress={() => {
                        setSelectedTake(item);
                        setScreen('takeDetail');
                      }}
                    >
                      <Text style={styles.smallButtonText}>Open</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.smallDangerButton}
                      onPress={() => confirmDeleteTake(item)}
                    >
                      <Text style={styles.smallButtonText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            />
          )}

          <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('home')}>
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'settings') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.container}>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.subtitle}>Manage your account and app info.</Text>

          <View style={styles.takeCard}>
            <Text style={styles.takeMeta}>Signed in as</Text>
            <Text style={styles.takeTitle}>{user.email}</Text>
          </View>

          <View style={styles.takeCard}>
            <Text style={styles.takeMeta}>App version</Text>
            <Text style={styles.takeTitle}>{APP_VERSION}</Text>
          </View>

          <TouchableOpacity style={styles.deleteButton} onPress={handleSignOut}>
            <Text style={styles.deleteButtonText}>Sign Out</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('home')}>
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <Text style={styles.title}>OneTake</Text>
        <Text style={styles.subtitle}>Signed in as: {user.email}</Text>

        <TouchableOpacity style={styles.primaryButton} onPress={openCamera}>
          <Text style={styles.primaryButtonText}>Record One Take</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('takes')}>
          <Text style={styles.secondaryButtonText}>View My Takes</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('settings')}>
          <Text style={styles.secondaryButtonText}>Settings</Text>
        </TouchableOpacity>

        <Text style={styles.versionText}>{APP_VERSION}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0B1020' },
  container: { flex: 1, paddingHorizontal: 24, justifyContent: 'center' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },

  title: { fontSize: 42, fontWeight: '800', color: '#FFFFFF', marginBottom: 12, textAlign: 'center' },
  subtitle: { fontSize: 16, lineHeight: 24, color: '#C7D2FE', textAlign: 'center', marginBottom: 24 },
  versionText: { marginTop: 8, color: '#64748B', fontSize: 12, textAlign: 'center' },

  input: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#334155',
    color: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },

  primaryButton: {
    backgroundColor: '#4F46E5',
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 14,
    alignItems: 'center',
  },
  stopButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },

  secondaryButton: {
    borderWidth: 1,
    borderColor: '#64748B',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryButtonText: { color: '#E2E8F0', fontSize: 16, fontWeight: '600' },

  deleteButton: {
    backgroundColor: '#B91C1C',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  deleteButtonText: { color: '#FFF', fontSize: 15, fontWeight: '700' },

  cameraScreen: { flex: 1, backgroundColor: '#000' },
  cameraPreview: { flex: 1 },

  webCameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#020617',
  },
  webCameraTitle: { color: '#FFFFFF', fontSize: 24, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  webCameraText: { color: '#C7D2FE', fontSize: 14, textAlign: 'center', marginBottom: 6 },

  cameraOverlay: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    padding: 16,
    backgroundColor: 'rgba(11,16,32,0.85)',
  },
  cameraTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  cameraSubtitle: { color: '#C7D2FE', fontSize: 14, textAlign: 'center', marginBottom: 14 },

  listContent: { paddingBottom: 16 },
  takeCard: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#111827',
  },
  takeTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  takeMeta: { color: '#94A3B8', fontSize: 12, marginBottom: 6 },
  takeUri: { color: '#CBD5E1', fontSize: 12, marginBottom: 4 },

  emptyCard: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    backgroundColor: '#111827',
  },
  emptyText: { color: '#CBD5E1', textAlign: 'center' },

  videoWrap: {
    height: 220,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 12,
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#334155',
  },
  video: { width: '100%', height: '100%', backgroundColor: '#000' },

  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  smallButton: {
    flex: 1,
    backgroundColor: '#334155',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  smallDangerButton: {
    flex: 1,
    backgroundColor: '#7F1D1D',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  smallButtonText: { color: '#FFF', fontWeight: '700' },

  infoText: { marginTop: 12, color: '#C7D2FE', textAlign: 'center' },
});
