import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  requireNativeComponent,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

const PROGRESS_KEY = 'replock.progress.v1';
const SETTINGS_KEY = 'replock.settings.v1';
const PUSHUP_OPTIONS = [5, 10, 15, 20];
const DETECTION_REFRESH_MS = 2500;
const UNLOCK_DURATION_OPTIONS = [
  { label: '1 minute', value: 60 * 1000 },
  { label: '5 minutes', value: 5 * 60 * 1000 },
  { label: '15 minutes', value: 15 * 60 * 1000 },
  { label: '30 minutes', value: 30 * 60 * 1000 },
  { label: '1 hour', value: 60 * 60 * 1000 },
];
const DEFAULT_UNLOCK_DURATION_MS = UNLOCK_DURATION_OPTIONS[0].value;
const EMPTY_DETECTION_DEBUG = {
  totalCount: 0,
  lastEvent: null,
  history: [],
  protectionStatus: {
    overlayVisible: false,
    activeBlockedPackage: null,
    lastForegroundPackage: null,
    selectedProtectedPackageNames: [],
    challengePackageName: null,
    unlockAppCalledPackageName: null,
    unlockedUntilSaved: 0,
    postUnlockGraceUntilSaved: 0,
    launchIntentFound: false,
    launchMethodUsed: null,
    finalLaunchSuccess: false,
    finalLaunchErrorReason: null,
    didMoveRepLockToBack: false,
    lastRedirectPackage: null,
    lastRedirectResult: null,
    lastRedirectAt: 0,
    lastUnlockPackage: null,
    lastUnlockAt: 0,
    lastLaunchPackage: null,
    lastLaunchResult: null,
    lastLaunchAt: 0,
    unlockedUntil: 0,
    remainingUnlockSeconds: 0,
    lastBlockReason: 'None yet',
    updatedAt: 0,
  },
};
const EMPTY_UNLOCK_SESSIONS = [];
const EMPTY_POSE_STATE = {
  status: 'Camera starting',
  bodyDetected: false,
  visibleLandmarks: 0,
  fps: 0,
  leftElbowAngle: 0,
  rightElbowAngle: 0,
};

const RepLockDetection = NativeModules.RepLockDetection;
const RepLockPoseCameraView =
  Platform.OS === 'android' ? requireNativeComponent('RepLockPoseCameraView') : null;

const PROTECTABLE_APPS = [
  {
    id: 'tiktok',
    name: 'TikTok',
    packageName: 'com.zhiliaoapp.musically',
    icon: 'TT',
    reason: 'Short video lock',
    enabled: true,
  },
  {
    id: 'instagram',
    name: 'Instagram',
    packageName: 'com.instagram.android',
    icon: 'IG',
    reason: 'Scroll limit',
    enabled: true,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    packageName: 'com.google.android.youtube',
    icon: 'YT',
    reason: 'Video lock',
    enabled: true,
  },
  {
    id: 'x-twitter',
    name: 'X/Twitter',
    packageName: 'com.twitter.android',
    icon: 'X',
    reason: 'Feed lock',
    enabled: false,
  },
  {
    id: 'games',
    name: 'Games',
    packageName: 'com.google.android.play.games',
    icon: 'GM',
    reason: 'Game access lock',
    enabled: false,
  },
];

const DEFAULT_LOCKED_APP_IDS = PROTECTABLE_APPS.filter((app) => app.enabled).map((app) => app.id);
const DEFAULT_PROTECTED_PACKAGE_NAMES = PROTECTABLE_APPS.filter((app) => app.enabled).map(
  (app) => app.packageName
);

const INITIAL_PROGRESS = {
  sessions: 0,
  totalPushups: 0,
  unlocks: 0,
  streak: 0,
  lastWorkoutDate: null,
  history: [],
};

const INITIAL_SETTINGS = {
  strictMode: true,
  reminders: false,
  sound: true,
  requiredPushups: 10,
  unlockDurationMs: DEFAULT_UNLOCK_DURATION_MS,
  lockedAppIds: DEFAULT_LOCKED_APP_IDS,
  protectedPackageNames: DEFAULT_PROTECTED_PACKAGE_NAMES,
};

export default function App() {
  const [screen, setScreen] = useState('home');
  const [selectedApp, setSelectedApp] = useState(PROTECTABLE_APPS[0]);
  const [installedApps, setInstalledApps] = useState(PROTECTABLE_APPS);
  const [counter, setCounter] = useState(0);
  const [poseState, setPoseState] = useState(EMPTY_POSE_STATE);
  const [progress, setProgress] = useState(INITIAL_PROGRESS);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [detectionDebug, setDetectionDebug] = useState(EMPTY_DETECTION_DEBUG);
  const [detectionError, setDetectionError] = useState(null);
  const [isDetectionLoading, setIsDetectionLoading] = useState(false);
  const [activeUnlockSessions, setActiveUnlockSessions] = useState(EMPTY_UNLOCK_SESSIONS);
  const [overlayPermissionGranted, setOverlayPermissionGranted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadState() {
      try {
        const [storedProgress, storedSettings] = await Promise.all([
          AsyncStorage.getItem(PROGRESS_KEY),
          AsyncStorage.getItem(SETTINGS_KEY),
        ]);

        if (storedProgress) {
          setProgress({ ...INITIAL_PROGRESS, ...JSON.parse(storedProgress) });
        }

        if (storedSettings) {
          setSettings(normalizeSettings(JSON.parse(storedSettings)));
        }
      } catch (error) {
        console.warn('Could not load RepLock data', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadState();
  }, []);

  useEffect(() => {
    if (!isLoading) {
      AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)).catch((error) => {
        console.warn('Could not save RepLock progress', error);
      });
    }
  }, [isLoading, progress]);

  useEffect(() => {
    if (!isLoading) {
      AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch((error) => {
        console.warn('Could not save RepLock settings', error);
      });
    }
  }, [isLoading, settings]);

  useEffect(() => {
    const syncPromise = RepLockDetection?.setRequiredPushups?.(settings.requiredPushups);
    syncPromise?.catch?.((error) => {
      console.warn('Could not sync RepLock required push-ups to native', error);
    });
  }, [settings.requiredPushups]);

  useEffect(() => {
    loadInstalledApps();
  }, []);

  useEffect(() => {
    function handleUrl(url) {
      const app = getChallengeAppFromUrl(url);
      if (app) {
        RepLockDetection?.recordChallengeOpened?.(app.packageName)?.catch?.((error) => {
          console.warn('Could not record RepLock challenge package', error);
        });
        startChallenge(app);
      }
    }

    Linking.getInitialURL().then((url) => {
      if (url) {
        handleUrl(url);
      }
    });

    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    refreshOverlayPermission();
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        refreshOverlayPermission();
      }
    });

    return () => appStateSubscription.remove();
  }, []);

  useEffect(() => {
    if (screen !== 'detection') {
      return undefined;
    }

    loadDetectionDebug();
    loadActiveUnlockSessions();
    const intervalId = setInterval(loadDetectionDebug, DETECTION_REFRESH_MS);
    const unlockIntervalId = setInterval(loadActiveUnlockSessions, DETECTION_REFRESH_MS);
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        loadDetectionDebug();
        loadActiveUnlockSessions();
      }
    });

    return () => {
      clearInterval(intervalId);
      clearInterval(unlockIntervalId);
      appStateSubscription.remove();
    };
  }, [screen]);

  useEffect(() => {
    if (screen === 'home') {
      loadActiveUnlockSessions();
    }
  }, [screen]);

  useEffect(() => {
    if (screen !== 'challenge' && screen !== 'cameraChallenge') {
      return undefined;
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelChallenge();
      return true;
    });

    return () => subscription.remove();
  }, [screen, selectedApp]);

  const todaysPushups = useMemo(() => {
    const today = getTodayKey();
    return progress.history
      .filter((item) => item.date === today)
      .reduce((sum, item) => sum + item.reps, 0);
  }, [progress.history]);

  const configuredApps = useMemo(
    () => getConfiguredApps(settings.protectedPackageNames, installedApps),
    [installedApps, settings.protectedPackageNames]
  );
  const lockedApps = useMemo(() => configuredApps.filter((app) => app.enabled), [configuredApps]);
  const activeApp =
    lockedApps.find((app) => app.packageName === selectedApp.packageName) ?? lockedApps[0] ?? null;

  useEffect(() => {
    if (!RepLockDetection?.setProtectedApps) {
      return;
    }

    const protectedApps = settings.protectedPackageNames.map((packageName) => {
      const app = configuredApps.find((item) => item.packageName === packageName);
      return {
        appName: app?.name ?? packageName,
        packageName,
      };
    });

    RepLockDetection.setProtectedApps(JSON.stringify(protectedApps)).catch((error) => {
      console.warn('Could not sync protected apps to native', error);
    });
  }, [configuredApps, settings.protectedPackageNames]);

  function startChallenge(app) {
    if (!app) {
      setScreen('settings');
      return;
    }

    setSelectedApp(app);
    setCounter(0);
    setScreen('challenge');
  }

  function addRep() {
    const nextValue = Math.min(settings.requiredPushups, counter + 1);
    setCounter(nextValue);

    if (nextValue === settings.requiredPushups) {
      completeChallenge();
    }
  }

  async function startCameraChallenge() {
    if (Platform.OS !== 'android') {
      Alert.alert('Android only', 'Camera pose detection is currently built for Android dev builds.');
      return;
    }

    try {
      const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
      const nextGranted =
        granted ||
        (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
          title: 'Camera permission',
          message: 'RepLock needs camera access to detect your push-up pose.',
          buttonPositive: 'Allow',
        })) === PermissionsAndroid.RESULTS.GRANTED;

      if (!nextGranted) {
        Alert.alert('Camera permission required', 'Manual counting is still available.');
        return;
      }

      setPoseState(EMPTY_POSE_STATE);
      setScreen('cameraChallenge');
    } catch (error) {
      console.warn('Could not request camera permission', error);
      Alert.alert('Camera unavailable', 'Manual counting is still available.');
    }
  }

  async function completeChallenge() {
    const today = getTodayKey();
    const unlockedApp = selectedApp;
    setProgress((current) => {
      const hadWorkoutToday = current.lastWorkoutDate === today;
      const nextHistory = [
        {
          id: `${Date.now()}`,
          appName: selectedApp.name,
          date: today,
          reps: settings.requiredPushups,
        },
        ...current.history,
      ].slice(0, 12);

      return {
        ...current,
        sessions: current.sessions + 1,
        totalPushups: current.totalPushups + settings.requiredPushups,
        unlocks: current.unlocks + 1,
        streak: hadWorkoutToday ? current.streak : current.streak + 1,
        lastWorkoutDate: today,
        history: nextHistory,
      };
    });

    if (unlockedApp?.packageName && RepLockDetection?.unlockApp) {
      try {
        await RepLockDetection.unlockApp(unlockedApp.packageName, settings.unlockDurationMs);
        await loadActiveUnlockSessions();
        setCounter(0);
        setScreen('home');
        return;
      } catch (error) {
        console.warn('Could not launch RepLock target app natively', error);
        try {
          await RepLockDetection?.finishOrMoveTaskToBack?.();
          setCounter(0);
          setScreen('home');
          return;
        } catch (fallbackError) {
          console.warn('Could not move RepLock to background', fallbackError);
          Alert.alert(
            'Could not show target app',
            `${unlockedApp.name} was unlocked, but Android did not let RepLock open or reveal it. Check Detection Debug for launch details.`
          );
        }
      }
    }

    setScreen('success');
  }

  function cancelChallenge() {
    const lockedApp = selectedApp;
    Alert.alert(
      'Challenge not completed',
      `${lockedApp.name} remains locked until you finish the push-up challenge.`,
      [
        { text: 'Keep going', style: 'cancel' },
        {
          text: 'Leave challenge',
          style: 'destructive',
          onPress: () => {
            if (lockedApp?.packageName) {
              const cancelPromise = RepLockDetection?.cancelChallenge?.(lockedApp.packageName);
              cancelPromise?.catch?.((error) => {
                console.warn('Could not cancel RepLock challenge natively', error);
              });
            }
            setCounter(0);
            setScreen('home');
          },
        },
      ]
    );
  }

  function handlePoseUpdate(event) {
    setPoseState(normalizePoseState(event.nativeEvent));
  }

  function resetProgress() {
    Alert.alert('Reset progress?', 'This clears your saved RepLock progress on this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => setProgress(INITIAL_PROGRESS),
      },
    ]);
  }

  async function loadDetectionDebug() {
    if (!RepLockDetection?.getDetectionDebug) {
      setDetectionError('Detection bridge unavailable. Rebuild the Android dev build.');
      return;
    }

    setIsDetectionLoading(true);
    try {
      const rawDebug = await RepLockDetection.getDetectionDebug();
      const parsedDebug = JSON.parse(rawDebug);
      setDetectionDebug(normalizeDetectionDebug(parsedDebug));
      setDetectionError(null);
    } catch (error) {
      setDetectionError('Could not load detection events.');
      console.warn('Could not load RepLock detection debug data', error);
    } finally {
      setIsDetectionLoading(false);
    }
  }

  async function loadActiveUnlockSessions() {
    try {
      const rawSessions = await RepLockDetection?.getActiveUnlockSessions?.();
      if (!rawSessions) {
        setActiveUnlockSessions(EMPTY_UNLOCK_SESSIONS);
        return;
      }
      setActiveUnlockSessions(normalizeUnlockSessions(JSON.parse(rawSessions)));
    } catch (error) {
      setActiveUnlockSessions(EMPTY_UNLOCK_SESSIONS);
    }
  }

  async function loadInstalledApps() {
    try {
      const rawApps = await RepLockDetection?.getInstalledLaunchableApps?.();
      if (!rawApps) {
        return;
      }
      setInstalledApps(mergeInstalledApps(JSON.parse(rawApps)));
    } catch (error) {
      console.warn('Could not load installed Android apps', error);
      setInstalledApps(PROTECTABLE_APPS);
    }
  }

  async function refreshOverlayPermission() {
    try {
      const granted = await RepLockDetection?.isOverlayPermissionGranted?.();
      setOverlayPermissionGranted(Boolean(granted));
    } catch (error) {
      setOverlayPermissionGranted(false);
    }
  }

  async function openOverlaySettings() {
    try {
      await RepLockDetection?.openOverlaySettings?.();
    } catch (error) {
      Alert.alert('Native permission flow coming next.');
    }
  }

  async function openAccessibilitySettings() {
    try {
      await RepLockDetection?.openAccessibilitySettings?.();
    } catch (error) {
      Alert.alert('Open Android Accessibility Settings from system settings.');
    }
  }

  function renderScreen() {
    if (isLoading) {
      return (
        <View style={styles.loadingState}>
          <ActivityIndicator color="#0f766e" />
          <Text style={styles.mutedText}>Loading RepLock</Text>
        </View>
      );
    }

    if (screen === 'apps') {
      return (
        <LockedAppsScreen
          requiredPushups={settings.requiredPushups}
          lockedApps={lockedApps}
          selectedApp={selectedApp}
          onBack={() => setScreen('home')}
          onStart={startChallenge}
        />
      );
    }

    if (screen === 'challenge') {
      return (
        <ChallengeScreen
          app={selectedApp}
          count={counter}
          onAddRep={addRep}
          onBack={cancelChallenge}
          onCameraChallenge={startCameraChallenge}
          onReset={() => setCounter(0)}
          requiredPushups={settings.requiredPushups}
        />
      );
    }

    if (screen === 'cameraChallenge') {
      return (
        <CameraChallengeScreen
          app={selectedApp}
          onBack={cancelChallenge}
          onManualFallback={() => setScreen('challenge')}
          onPoseUpdate={handlePoseUpdate}
          poseState={poseState}
          requiredPushups={settings.requiredPushups}
        />
      );
    }

    if (screen === 'success') {
      return (
        <SuccessScreen
          app={selectedApp}
          onHome={() => setScreen('home')}
          onProgress={() => setScreen('progress')}
          requiredPushups={settings.requiredPushups}
          unlockDurationMs={settings.unlockDurationMs}
        />
      );
    }

    if (screen === 'progress') {
      return (
        <ProgressScreen
          progress={progress}
          settings={settings}
          todaysPushups={todaysPushups}
          onBack={() => setScreen('home')}
        />
      );
    }

    if (screen === 'settings') {
      return (
        <SettingsScreen
          apps={configuredApps}
          installedApps={installedApps}
          onOpenAccessibilitySettings={openAccessibilitySettings}
          onOpenOverlaySettings={openOverlaySettings}
          settings={settings}
          overlayPermissionGranted={overlayPermissionGranted}
          onBack={() => setScreen('home')}
          onResetProgress={resetProgress}
          onUpdateSettings={setSettings}
          onRefreshInstalledApps={loadInstalledApps}
        />
      );
    }

    if (screen === 'detection') {
      return (
        <DetectionDebugScreen
          activeUnlockSessions={activeUnlockSessions}
          debug={detectionDebug}
          error={detectionError}
          isLoading={isDetectionLoading}
          onBack={() => setScreen('home')}
          onRefresh={loadDetectionDebug}
          unlockDurationMs={settings.unlockDurationMs}
        />
      );
    }

    return (
      <HomeScreen
        activeUnlockSessions={activeUnlockSessions}
        lockedApps={lockedApps}
        progress={progress}
        requiredPushups={settings.requiredPushups}
        selectedApp={activeApp}
        todaysPushups={todaysPushups}
        onOpenApps={() => setScreen('apps')}
        onOpenDetection={() => setScreen('detection')}
        onOpenProgress={() => setScreen('progress')}
        onOpenSettings={() => setScreen('settings')}
        onStart={startChallenge}
      />
    );
  }

  return (
    <View style={styles.app}>
      <StatusBar style="dark" />
      {renderScreen()}
    </View>
  );
}

function HomeScreen({
  activeUnlockSessions,
  lockedApps,
  onOpenApps,
  onOpenDetection,
  onOpenProgress,
  onOpenSettings,
  onStart,
  progress,
  requiredPushups,
  selectedApp,
  todaysPushups,
}) {
  return (
    <Screen title="RepLock" subtitle={`Earn app access with ${requiredPushups} honest push-ups.`}>
      <View style={styles.heroPanel}>
        <Text style={styles.eyebrow}>{selectedApp ? 'NEXT UNLOCK' : 'PROTECTION OFF'}</Text>
        <Text style={styles.heroTitle}>{selectedApp ? selectedApp.name : 'No locked apps'}</Text>
        <Text style={styles.heroCopy}>
          {selectedApp
            ? `${selectedApp.reason} waits behind a short set.`
            : 'Choose distracting apps to protect with push-up challenges.'}
        </Text>
        <PrimaryButton
          label={selectedApp ? `Start 0/${requiredPushups} challenge` : 'Choose locked apps'}
          onPress={() => (selectedApp ? onStart(selectedApp) : onOpenSettings())}
        />
      </View>

      <View style={styles.statsGrid}>
        <Stat label="Today" value={`${todaysPushups}`} suffix="push-ups" />
        <Stat label="Unlocks" value={`${progress.unlocks}`} suffix="total" />
      </View>

      <UnlockSessionsSection sessions={activeUnlockSessions} />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Protected apps</Text>
        {lockedApps.length === 0 ? (
          <Text style={styles.mutedText}>No apps selected yet.</Text>
        ) : (
          lockedApps.map((app) => (
            <AppAccessCard
              app={app}
              key={app.id}
              onPress={() => onStart(app)}
              requiredPushups={requiredPushups}
            />
          ))
        )}
      </View>

      <View style={styles.menuGrid}>
        <MenuButton label="Locked apps" detail="Choose what to unlock" onPress={onOpenApps} />
        <MenuButton label="Detection Debug" detail="View native service events" onPress={onOpenDetection} />
        <MenuButton label="Progress" detail="Stored on this device" onPress={onOpenProgress} />
        <MenuButton label="Settings" detail="Adjust RepLock" onPress={onOpenSettings} />
      </View>
    </Screen>
  );
}

function LockedAppsScreen({ lockedApps, onBack, onStart, requiredPushups, selectedApp }) {
  return (
    <Screen title="Locked apps" subtitle="Pick the app you want to earn access to." onBack={onBack}>
      <View style={styles.list}>
        {lockedApps.length === 0 ? (
          <Text style={styles.mutedText}>Enable apps in Settings to protect them.</Text>
        ) : (
          lockedApps.map((app) => {
            const isSelected = selectedApp.id === app.id;
            return (
              <Pressable
                accessibilityRole="button"
                key={app.id}
                onPress={() => onStart(app)}
                style={({ pressed }) => [
                  styles.appRow,
                  isSelected && styles.selectedRow,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.appMark}>
                  <Text style={styles.appMarkText}>{app.icon}</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{app.name}</Text>
                  <Text style={styles.rowDetail}>{app.reason}</Text>
                </View>
                <Text style={styles.rowAction}>0/{requiredPushups}</Text>
              </Pressable>
            );
          })
        )}
      </View>
    </Screen>
  );
}

function ChallengeScreen({ app, count, onAddRep, onBack, onCameraChallenge, onReset, requiredPushups }) {
  if (!app) {
    return (
      <Screen title="Push-up challenge" subtitle="Enable a locked app before starting." onBack={onBack}>
        <SecondaryButton label="Back to locked apps" onPress={onBack} />
      </Screen>
    );
  }

  const remaining = requiredPushups - count;

  return (
    <Screen
      title="Push-up challenge"
      subtitle={`Complete ${requiredPushups} push-ups to unlock ${app.name}.`}
      onBack={onBack}
    >
      <View style={styles.challengeDial}>
        <Text style={styles.challengeNumber}>{count}</Text>
        <Text style={styles.challengeTotal}>/{requiredPushups}</Text>
      </View>

      <Text style={styles.centerCopy}>
        {remaining > 0 ? `${remaining} reps left` : 'Challenge complete'}
      </Text>

      <PrimaryButton label="Add 1 push-up" onPress={onAddRep} />
      <SecondaryButton label="Camera Challenge" onPress={onCameraChallenge} />
      <SecondaryButton label="Reset counter" onPress={onReset} />
    </Screen>
  );
}

function CameraChallengeScreen({ app, onBack, onManualFallback, onPoseUpdate, poseState, requiredPushups }) {
  if (!app) {
    return (
      <Screen title="Camera challenge" subtitle="Enable a locked app before starting." onBack={onBack}>
        <SecondaryButton label="Back to manual counter" onPress={onManualFallback} />
      </Screen>
    );
  }

  return (
    <Screen
      title="Camera challenge"
      subtitle={`Complete ${requiredPushups} push-ups to unlock ${app.name}.`}
      onBack={onBack}
    >
      <View style={styles.cameraPanel}>
        {RepLockPoseCameraView ? (
          <RepLockPoseCameraView
            cameraFacing="front"
            onPoseUpdate={onPoseUpdate}
            style={styles.poseCameraView}
          />
        ) : (
          <View style={[styles.poseCameraView, styles.cameraUnavailable]}>
            <Text style={styles.heroCopy}>Android dev build required.</Text>
          </View>
        )}
      </View>

      <View style={styles.ruleCard}>
        <Text style={styles.sectionTitle}>{poseState.status}</Text>
        <Text style={styles.rowDetail}>
          {poseState.bodyDetected ? 'Body detected' : 'Move further back or improve lighting'}
        </Text>
        <Text style={styles.rowAction}>
          {poseState.visibleLandmarks} landmarks - {Math.round(poseState.fps)} FPS
        </Text>
      </View>

      <View style={styles.statsGrid}>
        <Stat label="Left elbow" value={`${Math.round(poseState.leftElbowAngle)}`} suffix="degrees" />
        <Stat label="Right elbow" value={`${Math.round(poseState.rightElbowAngle)}`} suffix="degrees" />
      </View>

      <SecondaryButton label="Use manual counter" onPress={onManualFallback} />
    </Screen>
  );
}

function SuccessScreen({ app, onHome, onProgress, requiredPushups, unlockDurationMs }) {
  if (!app) {
    return (
      <Screen title="Unlocked" subtitle="No locked app is currently selected.">
        <PrimaryButton label="Back home" onPress={onHome} />
      </Screen>
    );
  }

  return (
    <Screen title="Unlocked" subtitle={`${app.name} is open for your next session.`}>
      <View style={styles.successPanel}>
        <Text style={styles.successTitle}>{requiredPushups}/{requiredPushups} complete</Text>
        <Text style={styles.heroCopy}>{app.name} unlocked for {formatDurationLabel(unlockDurationMs)}.</Text>
      </View>
      <View style={styles.ruleCard}>
        <Text style={styles.sectionTitle}>Unlock session</Text>
        <Text style={styles.rowDetail}>
          Unlocked for {formatDurationLabel(unlockDurationMs)}, until approximately {formatTimestamp(Date.now() + unlockDurationMs)}.
        </Text>
      </View>

      <PrimaryButton label="Back home" onPress={onHome} />
      <SecondaryButton label="View progress" onPress={onProgress} />
    </Screen>
  );
}

function ProgressScreen({ onBack, progress, settings, todaysPushups }) {
  return (
    <Screen title="Progress" subtitle="Local progress stored on this device." onBack={onBack}>
      <View style={styles.statsGrid}>
        <Stat label="Sessions" value={`${progress.sessions}`} suffix="done" />
        <Stat label="Push-ups" value={`${progress.totalPushups}`} suffix="total" />
        <Stat label="Unlocks" value={`${progress.unlocks}`} suffix="earned" />
        <Stat label="Streak" value={`${progress.streak}`} suffix="days" />
      </View>

      <View style={styles.ruleCard}>
        <Text style={styles.sectionTitle}>Current unlock rule</Text>
        <Text style={styles.rowDetail}>
          Each blocked app requires {settings.requiredPushups} push-ups before access is restored.
        </Text>
        <Text style={styles.rowAction}>{todaysPushups} push-ups earned today</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent unlocks</Text>
        {progress.history.length === 0 ? (
          <Text style={styles.mutedText}>No unlocks yet.</Text>
        ) : (
          progress.history.map((item) => (
            <View key={item.id} style={styles.historyRow}>
              <Text style={styles.rowTitle}>{item.appName}</Text>
              <Text style={styles.rowDetail}>
                {item.date} - {item.reps} push-ups
              </Text>
            </View>
          ))
        )}
      </View>
    </Screen>
  );
}

function DetectionDebugScreen({ activeUnlockSessions, debug, error, isLoading, onBack, onRefresh, unlockDurationMs }) {
  const lastEvent = debug.lastEvent;
  const protectionStatus = debug.protectionStatus;

  return (
    <Screen
      title="Detection Debug"
      subtitle="Native AccessibilityService detections saved on this phone."
      onBack={onBack}
    >
      <View style={styles.ruleCard}>
        <Text style={styles.sectionTitle}>Last detected app</Text>
        <Text style={styles.rowTitle}>{lastEvent?.appName ?? 'None yet'}</Text>
        <Text selectable style={styles.rowDetail}>
          {lastEvent?.packageName ?? 'No package detected yet'}
        </Text>
        <Text style={styles.rowAction}>
          {lastEvent ? formatTimestamp(lastEvent.timestamp) : 'Waiting for first detection'}
        </Text>
      </View>

      <View style={styles.statsGrid}>
        <Stat label="Detections" value={`${debug.totalCount}`} suffix="total" />
        <Stat label="Recent" value={`${debug.history.length}`} suffix="stored" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Blocker lifecycle</Text>
        <DebugStatusRow label="Last detected app" value={lastEvent?.appName ?? 'None yet'} />
        <DebugStatusRow label="Unlock duration selected" value={formatDurationLabel(unlockDurationMs)} />
        <DebugStatusRow
          label="Selected protected packages"
          value={
            protectionStatus.selectedProtectedPackageNames.length > 0
              ? protectionStatus.selectedProtectedPackageNames.join(', ')
              : 'None'
          }
        />
        <DebugStatusRow label="Active blocked package" value={protectionStatus.activeBlockedPackage ?? 'None'} />
        <DebugStatusRow label="Last foreground package" value={protectionStatus.lastForegroundPackage ?? 'None'} />
        <DebugStatusRow label="Challenge package" value={protectionStatus.challengePackageName ?? 'None'} />
        <DebugStatusRow label="Unlock called package" value={protectionStatus.unlockAppCalledPackageName ?? 'None'} />
        <DebugStatusRow
          label="Unlocked until saved"
          value={protectionStatus.unlockedUntilSaved ? formatTimestamp(protectionStatus.unlockedUntilSaved) : 'Not saved'}
        />
        <DebugStatusRow
          label="Post-unlock grace until"
          value={
            protectionStatus.postUnlockGraceUntilSaved
              ? formatTimestamp(protectionStatus.postUnlockGraceUntilSaved)
              : 'Not saved'
          }
        />
        <DebugStatusRow label="Last redirect package" value={protectionStatus.lastRedirectPackage ?? 'None'} />
        <DebugStatusRow label="Last redirect result" value={protectionStatus.lastRedirectResult ?? 'None'} />
        <DebugStatusRow
          label="Last redirect at"
          value={protectionStatus.lastRedirectAt ? formatTimestamp(protectionStatus.lastRedirectAt) : 'No redirect yet'}
        />
        <DebugStatusRow label="Last unlock package" value={protectionStatus.lastUnlockPackage ?? 'None'} />
        <DebugStatusRow
          label="Last unlock at"
          value={protectionStatus.lastUnlockAt ? formatTimestamp(protectionStatus.lastUnlockAt) : 'No unlock yet'}
        />
        <DebugStatusRow label="Last launch package" value={protectionStatus.lastLaunchPackage ?? 'None'} />
        <DebugStatusRow label="Launch intent found" value={protectionStatus.launchIntentFound ? 'Yes' : 'No'} />
        <DebugStatusRow label="Launch method used" value={protectionStatus.launchMethodUsed ?? 'None'} />
        <DebugStatusRow label="Final launch success" value={protectionStatus.finalLaunchSuccess ? 'Yes' : 'No'} />
        <DebugStatusRow label="Launch error reason" value={protectionStatus.finalLaunchErrorReason ?? 'None'} />
        <DebugStatusRow label="Moved RepLock back" value={protectionStatus.didMoveRepLockToBack ? 'Yes' : 'No'} />
        <DebugStatusRow label="Last launch result" value={protectionStatus.lastLaunchResult ?? 'None'} />
        <DebugStatusRow
          label="Last launch at"
          value={protectionStatus.lastLaunchAt ? formatTimestamp(protectionStatus.lastLaunchAt) : 'No launch yet'}
        />
        <DebugStatusRow
          label="Unlocked until"
          value={protectionStatus.unlockedUntil ? formatTimestamp(protectionStatus.unlockedUntil) : 'Locked'}
        />
        <DebugStatusRow label="Remaining unlock" value={`${protectionStatus.remainingUnlockSeconds}s`} />
        <DebugStatusRow label="Last block reason" value={protectionStatus.lastBlockReason ?? 'None yet'} />
        <DebugStatusRow label="Overlay visible" value={protectionStatus.overlayVisible ? 'Yes' : 'No'} />
        <DebugStatusRow
          label="Debug updated"
          value={protectionStatus.updatedAt ? formatTimestamp(protectionStatus.updatedAt) : 'Waiting'}
        />
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <PrimaryButton label={isLoading ? 'Refreshing...' : 'Refresh'} onPress={onRefresh} />
      <Text style={styles.mutedText}>Live updates refresh while this screen is open.</Text>

      <UnlockSessionsSection sessions={activeUnlockSessions} />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent detection history</Text>
        {debug.history.length === 0 ? (
          <Text style={styles.mutedText}>No detections saved yet.</Text>
        ) : (
          debug.history.map((item, index) => (
            <View key={`${item.packageName}-${item.timestamp}-${index}`} style={styles.historyRow}>
              <Text style={styles.rowTitle}>{item.appName}</Text>
              <Text selectable style={styles.rowDetail}>{item.packageName}</Text>
              <Text style={styles.rowAction}>{formatTimestamp(item.timestamp)}</Text>
            </View>
          ))
        )}
      </View>
    </Screen>
  );
}

function UnlockSessionsSection({ sessions }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Active unlock sessions</Text>
      {sessions.length === 0 ? (
        <Text style={styles.mutedText}>No apps are currently unlocked.</Text>
      ) : (
        sessions.map((session) => (
          <View key={session.packageName} style={styles.historyRow}>
            <Text style={styles.rowTitle}>{session.appName}</Text>
            <Text selectable style={styles.rowDetail}>{session.packageName}</Text>
            <Text style={styles.rowAction}>
              {formatRemainingTime(session.remainingMs)} left - until {formatTimestamp(session.unlockedUntil)}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function DebugStatusRow({ label, value }) {
  return (
    <View style={styles.historyRow}>
      <Text style={styles.rowTitle}>{label}</Text>
      <Text selectable style={styles.rowDetail}>{value}</Text>
    </View>
  );
}

function SettingsScreen({
  apps,
  installedApps,
  onBack,
  onOpenAccessibilitySettings,
  onOpenOverlaySettings,
  onRefreshInstalledApps,
  onResetProgress,
  onUpdateSettings,
  overlayPermissionGranted,
  settings,
}) {
  const [appSearch, setAppSearch] = useState('');
  const filteredApps = useMemo(() => {
    const query = appSearch.trim().toLowerCase();
    return apps
      .filter((app) => {
        if (!query) {
          return true;
        }
        return app.name.toLowerCase().includes(query) || app.packageName.toLowerCase().includes(query);
      })
      .sort((left, right) => {
        if (left.enabled !== right.enabled) {
          return left.enabled ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
  }, [appSearch, apps]);

  function updateSetting(key, value) {
    onUpdateSettings((current) => ({ ...current, [key]: value }));
  }

  function toggleProtectedApp(packageName, isEnabled) {
    onUpdateSettings((current) => {
      const currentPackages = current.protectedPackageNames ?? [];
      const nextPackages = isEnabled
        ? Array.from(new Set([...currentPackages, packageName]))
        : currentPackages.filter((item) => item !== packageName);

      return { ...current, protectedPackageNames: nextPackages };
    });
  }

  return (
    <Screen title="Settings" subtitle="Tune the MVP lock behavior." onBack={onBack}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Protection Setup</Text>
        <Text style={styles.rowDetail}>
          RepLock needs these permissions to detect when locked apps open and show the push-up challenge.
        </Text>
        <PermissionCard
          detail="Allows RepLock to detect when a protected app becomes active."
          label="App Protection"
          onPress={onOpenAccessibilitySettings}
          status="Permission required"
          buttonLabel="Open Android Accessibility Settings"
        />
        <PermissionCard
          detail="Allows RepLock to place the challenge screen above distracting apps."
          label="Overlay Permission"
          onPress={onOpenOverlaySettings}
          status={overlayPermissionGranted ? 'Enabled' : 'Not enabled'}
          buttonLabel="Enable Overlay"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Choose protected apps</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setAppSearch}
          placeholder="Search installed apps"
          placeholderTextColor="#94a3b8"
          style={styles.searchInput}
          value={appSearch}
        />
        <Text style={styles.rowDetail}>
          {settings.protectedPackageNames.length} protected apps selected from {installedApps.length} launchable apps.
        </Text>
        <SecondaryButton label="Refresh installed apps" onPress={onRefreshInstalledApps} />
        {filteredApps.length === 0 ? (
          <Text style={styles.mutedText}>No installed apps match this search.</Text>
        ) : (
          filteredApps.map((app) => (
            <AppToggleCard
              app={app}
              key={app.packageName}
              onValueChange={(value) => toggleProtectedApp(app.packageName, value)}
            />
          ))
        )}
      </View>

      <SettingSwitch
        label="Strict mode"
        detail={`Challenge must reach ${settings.requiredPushups}/${settings.requiredPushups} before unlock.`}
        value={settings.strictMode}
        onValueChange={(value) => updateSetting('strictMode', value)}
      />
      <SettingSwitch
        label="Reminders"
        detail="Keep the reminder preference for the next build."
        value={settings.reminders}
        onValueChange={(value) => updateSetting('reminders', value)}
      />
      <SettingSwitch
        label="Sound"
        detail="Keep sound enabled for future feedback."
        value={settings.sound}
        onValueChange={(value) => updateSetting('sound', value)}
      />

      <View style={styles.settingCard}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>Required push-ups per unlock</Text>
          <Text style={styles.rowDetail}>
            This controls how many reps unlock a blocked app.
          </Text>
        </View>
      </View>

      <View style={styles.optionRow}>
        {PUSHUP_OPTIONS.map((option) => (
          <OptionButton
            isSelected={settings.requiredPushups === option}
            key={option}
            label={`${option}`}
            onPress={() => updateSetting('requiredPushups', option)}
          />
        ))}
      </View>

      <View style={styles.settingCard}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>Unlock duration</Text>
          <Text style={styles.rowDetail}>
            This controls how long an app stays open after a completed challenge.
          </Text>
        </View>
      </View>

      <View style={styles.optionRow}>
        {UNLOCK_DURATION_OPTIONS.map((option) => (
          <OptionButton
            isSelected={settings.unlockDurationMs === option.value}
            key={option.value}
            label={option.label}
            onPress={() => updateSetting('unlockDurationMs', option.value)}
          />
        ))}
      </View>

      <SecondaryButton label="Reset local progress" onPress={onResetProgress} />
    </Screen>
  );
}

function Screen({ children, onBack, subtitle, title }) {
  return (
    <ScrollView
      contentContainerStyle={styles.screenContent}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.header}>
        <View style={styles.headerTop}>
          {onBack ? <SmallButton label="Back" onPress={onBack} /> : <View />}
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      {children}
    </ScrollView>
  );
}

function PrimaryButton({ label, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ label, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
    >
      <Text style={styles.smallButtonText}>{label}</Text>
    </Pressable>
  );
}

function OptionButton({ isSelected, label, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionButton,
        isSelected && styles.optionButtonSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.optionButtonText, isSelected && styles.optionButtonTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function AppAccessCard({ app, onPress, requiredPushups }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.appRow, pressed && styles.pressed]}
    >
      <View style={styles.appMark}>
        <Text style={styles.appMarkText}>{app.icon}</Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{app.name}</Text>
        <Text style={styles.rowDetail}>{app.packageName}</Text>
      </View>
      <Text style={styles.rowAction}>0/{requiredPushups}</Text>
    </Pressable>
  );
}

function AppToggleCard({ app, onValueChange }) {
  return (
    <View style={styles.appRow}>
      <View style={styles.appMark}>
        <Text style={styles.appMarkText}>{app.icon}</Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{app.name}</Text>
        <Text selectable style={styles.rowDetail}>{app.packageName}</Text>
      </View>
      <Switch
        onValueChange={onValueChange}
        thumbColor={app.enabled ? '#ffffff' : '#f8fafc'}
        trackColor={{ false: '#cbd5e1', true: '#0f766e' }}
        value={app.enabled}
      />
    </View>
  );
}

function PermissionCard({ buttonLabel, detail, label, onPress, status }) {
  const isEnabled = status === 'Enabled';

  return (
    <View style={styles.permissionCard}>
      <View style={styles.permissionHeader}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{label}</Text>
          <Text style={styles.rowDetail}>{detail}</Text>
        </View>
        <View style={[styles.statusPill, isEnabled && styles.statusPillEnabled]}>
          <Text style={[styles.statusPillText, isEnabled && styles.statusPillTextEnabled]}>
            {status}
          </Text>
        </View>
      </View>
      <SecondaryButton label={buttonLabel ?? `Enable ${label.replace(' Permission', '')}`} onPress={onPress} />
    </View>
  );
}

function MenuButton({ detail, label, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}
    >
      <Text style={styles.rowTitle}>{label}</Text>
      <Text style={styles.rowDetail}>{detail}</Text>
    </Pressable>
  );
}

function SettingSwitch({ detail, label, onValueChange, value }) {
  return (
    <View style={styles.settingCard}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <Switch
        onValueChange={onValueChange}
        thumbColor={value ? '#ffffff' : '#f8fafc'}
        trackColor={{ false: '#cbd5e1', true: '#0f766e' }}
        value={value}
      />
    </View>
  );
}

function Stat({ label, suffix, value }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statSuffix}>{suffix}</Text>
    </View>
  );
}

function normalizeSettings(storedSettings) {
  const lockedAppIds = Array.isArray(storedSettings.lockedAppIds)
    ? storedSettings.lockedAppIds.filter((id) => PROTECTABLE_APPS.some((app) => app.id === id))
    : DEFAULT_LOCKED_APP_IDS;
  const migratedPackages = lockedAppIds
    .map((id) => PROTECTABLE_APPS.find((app) => app.id === id)?.packageName)
    .filter(Boolean);
  const protectedPackageNames = Array.isArray(storedSettings.protectedPackageNames)
    ? storedSettings.protectedPackageNames.map(String).filter(Boolean)
    : migratedPackages.length > 0
      ? migratedPackages
      : DEFAULT_PROTECTED_PACKAGE_NAMES;

  const nextSettings = {
    strictMode: Boolean(storedSettings.strictMode ?? INITIAL_SETTINGS.strictMode),
    reminders: Boolean(storedSettings.reminders ?? INITIAL_SETTINGS.reminders),
    sound: Boolean(storedSettings.sound ?? INITIAL_SETTINGS.sound),
    requiredPushups: Number(storedSettings.requiredPushups ?? INITIAL_SETTINGS.requiredPushups),
    unlockDurationMs: Number(storedSettings.unlockDurationMs ?? INITIAL_SETTINGS.unlockDurationMs),
    lockedAppIds,
    protectedPackageNames: Array.from(new Set(protectedPackageNames)),
  };

  if (!PUSHUP_OPTIONS.includes(nextSettings.requiredPushups)) {
    nextSettings.requiredPushups = INITIAL_SETTINGS.requiredPushups;
  }

  if (!UNLOCK_DURATION_OPTIONS.some((option) => option.value === nextSettings.unlockDurationMs)) {
    nextSettings.unlockDurationMs = INITIAL_SETTINGS.unlockDurationMs;
  }

  return nextSettings;
}

function normalizeDetectionDebug(debug) {
  const history = Array.isArray(debug.history)
    ? debug.history.map(normalizeDetectionEvent).filter(Boolean)
    : [];

  return {
    totalCount: Number(debug.totalCount ?? 0),
    lastEvent: normalizeDetectionEvent(debug.lastEvent),
    history,
    protectionStatus: normalizeProtectionStatus(debug.protectionStatus),
  };
}

function normalizePoseState(state) {
  return {
    status: typeof state.status === 'string' ? state.status : EMPTY_POSE_STATE.status,
    bodyDetected: Boolean(state.bodyDetected),
    visibleLandmarks: Number(state.visibleLandmarks ?? 0),
    fps: Number(state.fps ?? 0),
    leftElbowAngle: Number(state.leftElbowAngle ?? 0),
    rightElbowAngle: Number(state.rightElbowAngle ?? 0),
  };
}

function normalizeProtectionStatus(status) {
  if (!status || typeof status !== 'object') {
    return EMPTY_DETECTION_DEBUG.protectionStatus;
  }

  return {
    overlayVisible: Boolean(status.overlayVisible),
    activeBlockedPackage: nullableString(status.activeBlockedPackage),
    lastForegroundPackage: nullableString(status.lastForegroundPackage),
    selectedProtectedPackageNames: Array.isArray(status.selectedProtectedPackageNames)
      ? status.selectedProtectedPackageNames.map(String)
      : [],
    challengePackageName: nullableString(status.challengePackageName),
    unlockAppCalledPackageName: nullableString(status.unlockAppCalledPackageName),
    unlockedUntilSaved: Number(status.unlockedUntilSaved ?? 0),
    postUnlockGraceUntilSaved: Number(status.postUnlockGraceUntilSaved ?? 0),
    launchIntentFound: Boolean(status.launchIntentFound),
    launchMethodUsed: nullableString(status.launchMethodUsed),
    finalLaunchSuccess: Boolean(status.finalLaunchSuccess),
    finalLaunchErrorReason: nullableString(status.finalLaunchErrorReason),
    didMoveRepLockToBack: Boolean(status.didMoveRepLockToBack),
    lastRedirectPackage: nullableString(status.lastRedirectPackage),
    lastRedirectResult: nullableString(status.lastRedirectResult),
    lastRedirectAt: Number(status.lastRedirectAt ?? 0),
    lastUnlockPackage: nullableString(status.lastUnlockPackage),
    lastUnlockAt: Number(status.lastUnlockAt ?? 0),
    lastLaunchPackage: nullableString(status.lastLaunchPackage ?? status.lastLaunchAttemptPackage),
    lastLaunchResult: nullableString(status.lastLaunchResult),
    lastLaunchAt: Number(status.lastLaunchAt ?? 0),
    unlockedUntil: Number(status.unlockedUntil ?? 0),
    remainingUnlockSeconds: Number(
      status.remainingUnlockSeconds ?? status.activeUnlockRemainingSeconds ?? 0
    ),
    lastBlockReason: String(status.lastBlockReason ?? 'None yet'),
    updatedAt: Number(status.updatedAt ?? 0),
  };
}

function nullableString(value) {
  if (value === null || value === undefined || value === 'null') {
    return null;
  }

  return String(value);
}

function normalizeDetectionEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return {
    appName: String(event.appName ?? 'Unknown app'),
    packageName: String(event.packageName ?? 'unknown.package'),
    timestamp: Number(event.timestamp ?? Date.now()),
  };
}

function normalizeUnlockSessions(sessions) {
  if (!Array.isArray(sessions)) {
    return EMPTY_UNLOCK_SESSIONS;
  }

  return sessions
    .map((session) => ({
      appName: String(session.appName ?? 'Unknown app'),
      packageName: String(session.packageName ?? 'unknown.package'),
      unlockedUntil: Number(session.unlockedUntil ?? 0),
      remainingMs: Number(session.remainingMs ?? 0),
    }))
    .filter((session) => session.unlockedUntil > Date.now());
}

function getConfiguredApps(protectedPackageNames, installedApps) {
  return mergeInstalledApps(installedApps).map((app) => ({
    ...app,
    enabled: protectedPackageNames.includes(app.packageName),
  }));
}

function mergeInstalledApps(nativeApps) {
  const byPackageName = new Map();

  PROTECTABLE_APPS.forEach((app) => {
    byPackageName.set(app.packageName, {
      ...app,
      id: app.packageName,
      appName: app.name,
    });
  });

  if (Array.isArray(nativeApps)) {
    nativeApps.forEach((app) => {
      if (!app?.packageName) {
        return;
      }
      const packageName = String(app.packageName);
      const existing = byPackageName.get(packageName);
      const appName = String(app.appName ?? app.name ?? existing?.name ?? packageName);
      byPackageName.set(packageName, {
        ...existing,
        id: packageName,
        name: appName,
        appName,
        packageName,
        icon: String(app.icon ?? existing?.icon ?? getAppInitials(appName)),
        reason: existing?.reason ?? 'App access lock',
      });
    });
  }

  return Array.from(byPackageName.values()).sort((left, right) => {
    const leftDefault = DEFAULT_PROTECTED_PACKAGE_NAMES.includes(left.packageName);
    const rightDefault = DEFAULT_PROTECTED_PACKAGE_NAMES.includes(right.packageName);
    if (leftDefault !== rightDefault) {
      return leftDefault ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function getChallengeAppFromUrl(url) {
  if (!url || !url.includes('challenge')) {
    return null;
  }

  const query = url.split('?')[1] ?? '';
  const params = {};
  query.split('&').forEach((part) => {
    const [key, value] = part.split('=');
    if (key) {
      params[key] = decodeURIComponent(value ?? '');
    }
  });

  if (!params.packageName) {
    return null;
  }

  const fallbackName = params.appName || params.packageName || 'Locked app';
  return (
    PROTECTABLE_APPS.find((app) => app.packageName === params.packageName) ?? {
      id: params.packageName,
      name: fallbackName,
      appName: fallbackName,
      packageName: params.packageName,
      icon: getAppInitials(fallbackName),
      reason: 'App access lock',
      enabled: true,
    }
  );
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return 'No timestamp';
  }

  return new Date(timestamp).toLocaleString();
}

function formatRemainingTime(remainingMs) {
  if (remainingMs < 60000) {
    return `${Math.max(0, Math.ceil(remainingMs / 1000))}s`;
  }

  const minutes = Math.max(0, Math.ceil(remainingMs / 60000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }

  return `${minutes}m`;
}

function formatDurationLabel(durationMs) {
  return UNLOCK_DURATION_OPTIONS.find((option) => option.value === durationMs)?.label ?? formatRemainingTime(durationMs);
}

function getAppInitials(appName) {
  return String(appName)
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
    .slice(0, 3) || 'APP';
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

const styles = StyleSheet.create({
  app: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  screenContent: {
    gap: 18,
    padding: 20,
    paddingBottom: 36,
  },
  header: {
    gap: 6,
    paddingTop: 18,
  },
  headerTop: {
    minHeight: 38,
  },
  title: {
    color: '#0f172a',
    fontSize: 34,
    fontWeight: '800',
  },
  subtitle: {
    color: '#475569',
    fontSize: 16,
    lineHeight: 22,
  },
  heroPanel: {
    backgroundColor: '#10231f',
    borderColor: '#173c36',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 20,
  },
  eyebrow: {
    color: '#99f6e4',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
  },
  heroTitle: {
    color: '#ffffff',
    fontSize: 36,
    fontWeight: '900',
  },
  heroCopy: {
    color: '#cbd5e1',
    fontSize: 16,
    lineHeight: 23,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '47%',
    flexGrow: 1,
    gap: 4,
    padding: 16,
  },
  statLabel: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '700',
  },
  statValue: {
    color: '#0f172a',
    fontSize: 30,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  statSuffix: {
    color: '#475569',
    fontSize: 13,
  },
  menuGrid: {
    gap: 12,
  },
  menuButton: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 16,
  },
  list: {
    gap: 12,
  },
  appRow: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    padding: 14,
  },
  selectedRow: {
    borderColor: '#0f766e',
  },
  appMark: {
    alignItems: 'center',
    backgroundColor: '#ccfbf1',
    borderCurve: 'continuous',
    borderRadius: 8,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  appMarkText: {
    color: '#0f766e',
    fontSize: 18,
    fontWeight: '900',
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '800',
  },
  rowDetail: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 18,
  },
  rowAction: {
    color: '#0f766e',
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  challengeDial: {
    alignItems: 'baseline',
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: 22,
  },
  challengeNumber: {
    color: '#0f172a',
    fontSize: 112,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  challengeTotal: {
    color: '#64748b',
    fontSize: 36,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  centerCopy: {
    color: '#475569',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  cameraPanel: {
    backgroundColor: '#10231f',
    borderColor: '#173c36',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  poseCameraView: {
    aspectRatio: 3 / 4,
    width: '100%',
  },
  cameraUnavailable: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  successPanel: {
    alignItems: 'center',
    backgroundColor: '#0f766e',
    borderCurve: 'continuous',
    borderRadius: 8,
    gap: 8,
    padding: 22,
  },
  successTitle: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '900',
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '900',
  },
  historyRow: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 14,
  },
  searchInput: {
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    color: '#0f172a',
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  ruleCard: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  permissionCard: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  permissionHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  statusPill: {
    backgroundColor: '#fee2e2',
    borderCurve: 'continuous',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusPillEnabled: {
    backgroundColor: '#ccfbf1',
  },
  statusPillText: {
    color: '#991b1b',
    fontSize: 12,
    fontWeight: '900',
  },
  statusPillTextEnabled: {
    color: '#0f766e',
  },
  settingCard: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    padding: 16,
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    flexGrow: 1,
    minWidth: 74,
    padding: 14,
  },
  optionButtonSelected: {
    backgroundColor: '#0f766e',
    borderColor: '#0f766e',
  },
  optionButtonText: {
    color: '#0f172a',
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  optionButtonTextSelected: {
    color: '#ffffff',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#0f766e',
    borderCurve: 'continuous',
    borderRadius: 8,
    padding: 16,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    padding: 15,
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '800',
  },
  smallButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#e2e8f0',
    borderCurve: 'continuous',
    borderRadius: 8,
    minHeight: 38,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  smallButtonText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.76,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
  },
  mutedText: {
    color: '#64748b',
    fontSize: 14,
  },
  errorText: {
    color: '#991b1b',
    fontSize: 14,
    fontWeight: '800',
  },
});
