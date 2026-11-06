using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using UnityEngine;
using UnityEngine.UI;

namespace RecBlueBranding
{
    // REC BLUE 2.5.0
    // - perf : vsync coupe, fps non plafonnes, priorite process haute ;
    // - marque : sprites du logo remplaces par REC BLUE ;
    // - bleu : palette RRUI + teintes runtime (Graphic.color, ColorBlock) + recoloration
    //   des TEXTURES orange (c'est la que vivaient le bouton JOUER et le fond a motifs).
    // Tout le travail est fait une seule fois au demarrage, puis le plugin se desactive.
    [BepInPlugin("net.recblue.branding", "REC BLUE - marque du jeu", "2.6.0")]
    public class BrandingPlugin : BasePlugin
    {
        internal static ManualLogSource Trace;

        public override void Load()
        {
            Trace = Log;
            QuietConsole.Install(Log);
            QualityGuard.Capture(Log);
            Log.LogInfo("REC BLUE 2.6.0 : plugin charge (vsync off, plafond ecran, priorite high).");
            AddComponent<BrandingScan>();
            AddComponent<FpsProbe>();
        }
    }

    // Mesure de FPS isolee : quelques lignes de journal, puis l'objet se detruit.
    public class FpsProbe : MonoBehaviour
    {
        public FpsProbe(IntPtr ptr) : base(ptr) { }

        private int frames;
        private int samples;
        private float last;
        private float worst;
        private int slow;

        private void Update()
        {
            // La moyenne peut etre bonne alors que le jeu saccade sur un pic isole :
            // c'est ce pic qui se ressent, donc on le mesure.
            float dt = Time.unscaledDeltaTime;
            if (dt > worst) worst = dt;
            if (dt > 0.0167f) slow++;

            float now = Time.realtimeSinceStartup;
            if (last <= 0f)
            {
                last = now;
                frames = Time.frameCount;
                return;
            }
            if (now - last < 5f) return;
            int delta = Time.frameCount - frames;
            float seconds = now - last;
            samples++;
            BrandingPlugin.Trace.LogInfo("fpsprobe : " + Mathf.RoundToInt(delta / Mathf.Max(0.001f, seconds)) + " fps | pire frame " + Mathf.RoundToInt(worst * 1000f) + " ms | frames lentes " + slow + " (echantillon " + samples + ")");
            last = now;
            frames = Time.frameCount;
            worst = 0f;
            slow = 0;
            if (samples >= 24) Destroy(this);
        }
    }

    // ---------------------------------------------------------------- console
    // Le client 2023 interroge des services morts (localisation, analytics, 404).
    // Ces lignes noient la console : on les jette avant qu'elles n'atteignent les
    // listeners, et on laisse passer tout le reste.
    // ---------------------------------------------------------------- qualite
    // Le plugin ne doit jamais degrader le rendu. On photographie les reglages
    // visuels au chargement, puis on les remet en place des qu'un seul bouge.
    // Les reglages de cadence (vsync, plafond fps, maxQueuedFrames) ne sont pas
    // concernes : ce ne sont pas des reglages visuels.
    // Pour laisser le jeu libre de changer (menu options), il suffit de creer
    // RECBLUE_QUALITE_LIBRE.txt : le garde-fou se met alors en veille.
    public static class QualityGuard
    {
        private const string FreeMarker = "C:\\RecRoom2023\\BepInEx\\plugins\\RECBLUE_QUALITE_LIBRE.txt";

        private static bool captured;
        private static bool freeMode;
        private static bool freeChecked;
        private static bool resolutionReported;
        private static float nextCheck;
        private static int restored;

        private static UnityEngine.ShadowQuality shadows;
        private static UnityEngine.ShadowResolution shadowResolution;
        private static UnityEngine.ShadowProjection shadowProjection;
        private static float shadowDistance;
        private static int antiAliasing;
        private static int textureLimit;
        private static UnityEngine.AnisotropicFiltering anisotropy;
        private static float lodBias;
        private static int pixelLights;
        private static bool softParticles;
        private static bool reflectionProbes;
        private static int screenWidth;
        private static int screenHeight;

        internal static void Capture(BepInEx.Logging.ManualLogSource log)
        {
            if (captured) return;
            captured = true;
            try
            {
                shadows = UnityEngine.QualitySettings.shadows;
                shadowResolution = UnityEngine.QualitySettings.shadowResolution;
                shadowProjection = UnityEngine.QualitySettings.shadowProjection;
                shadowDistance = UnityEngine.QualitySettings.shadowDistance;
                antiAliasing = UnityEngine.QualitySettings.antiAliasing;
                textureLimit = UnityEngine.QualitySettings.masterTextureLimit;
                anisotropy = UnityEngine.QualitySettings.anisotropicFiltering;
                lodBias = UnityEngine.QualitySettings.lodBias;
                pixelLights = UnityEngine.QualitySettings.pixelLightCount;
                softParticles = UnityEngine.QualitySettings.softParticles;
                reflectionProbes = UnityEngine.QualitySettings.realtimeReflectionProbes;
                screenWidth = UnityEngine.Screen.width;
                screenHeight = UnityEngine.Screen.height;
                log.LogInfo("qualite : verrouillee (ombres=" + shadows + ", AA=" + antiAliasing + ", mip=" + textureLimit + ", LOD=" + lodBias.ToString("0.0") + ", lumieres=" + pixelLights + ", " + screenWidth + "x" + screenHeight + ")");
            }
            catch (Exception error)
            {
                log.LogWarning("qualite : photographie impossible (" + error.Message + ").");
            }
        }

        internal static void Enforce(BepInEx.Logging.ManualLogSource log, float now)
        {
            if (!captured) return;
            if (now < nextCheck) return;
            nextCheck = now + 2f;
            try
            {
                if (!freeChecked)
                {
                    freeChecked = true;
                    try { freeMode = System.IO.File.Exists(FreeMarker); } catch { }
                    if (freeMode) log.LogInfo("qualite : garde-fou en veille (RECBLUE_QUALITE_LIBRE.txt present).");
                }
                if (!resolutionReported && (UnityEngine.Screen.width != screenWidth || UnityEngine.Screen.height != screenHeight))
                {
                    resolutionReported = true;
                    log.LogWarning("qualite : resolution changee par le jeu (" + UnityEngine.Screen.width + "x" + UnityEngine.Screen.height + "), laissee telle quelle.");
                }
                if (freeMode) return;
                if (UnityEngine.QualitySettings.shadows != shadows)
                {
                    UnityEngine.QualitySettings.shadows = shadows;
                    Restore(log, "ombres");
                }
                if (UnityEngine.QualitySettings.shadowResolution != shadowResolution)
                {
                    UnityEngine.QualitySettings.shadowResolution = shadowResolution;
                    Restore(log, "precision des ombres");
                }
                if (UnityEngine.QualitySettings.shadowProjection != shadowProjection)
                {
                    UnityEngine.QualitySettings.shadowProjection = shadowProjection;
                    Restore(log, "projection des ombres");
                }
                if (Mathf.Abs(UnityEngine.QualitySettings.shadowDistance - shadowDistance) > 0.01f)
                {
                    UnityEngine.QualitySettings.shadowDistance = shadowDistance;
                    Restore(log, "distance des ombres");
                }
                if (UnityEngine.QualitySettings.antiAliasing != antiAliasing)
                {
                    UnityEngine.QualitySettings.antiAliasing = antiAliasing;
                    Restore(log, "anti-aliasing");
                }
                if (UnityEngine.QualitySettings.masterTextureLimit != textureLimit)
                {
                    UnityEngine.QualitySettings.masterTextureLimit = textureLimit;
                    Restore(log, "taille des textures");
                }
                if (UnityEngine.QualitySettings.anisotropicFiltering != anisotropy)
                {
                    UnityEngine.QualitySettings.anisotropicFiltering = anisotropy;
                    Restore(log, "filtrage anisotrope");
                }
                if (Mathf.Abs(UnityEngine.QualitySettings.lodBias - lodBias) > 0.001f)
                {
                    UnityEngine.QualitySettings.lodBias = lodBias;
                    Restore(log, "niveau de detail");
                }
                if (UnityEngine.QualitySettings.pixelLightCount != pixelLights)
                {
                    UnityEngine.QualitySettings.pixelLightCount = pixelLights;
                    Restore(log, "lumieres par pixel");
                }
                if (UnityEngine.QualitySettings.softParticles != softParticles)
                {
                    UnityEngine.QualitySettings.softParticles = softParticles;
                    Restore(log, "particules douces");
                }
                if (UnityEngine.QualitySettings.realtimeReflectionProbes != reflectionProbes)
                {
                    UnityEngine.QualitySettings.realtimeReflectionProbes = reflectionProbes;
                    Restore(log, "reflets temps reel");
                }
            }
            catch { }
        }

        private static void Restore(BepInEx.Logging.ManualLogSource log, string name)
        {
            restored++;
            log.LogWarning("qualite : " + name + " remis au reglage d'origine (" + restored + ").");
        }
    }

    public static class QuietConsole
    {
        private static readonly string[] Noise =
        {
            "HTTP Error",
            "Failed to retrieve strings",
            "trying to download strings",
            "Response was empty",
            "Gamesight",
            "Unknown Material guid",
            "Could not find an entry with key",
            "Processing queued table"
        };

        private static int hidden;
        private static bool installed;

        public static int Hidden { get { return hidden; } }

        internal static void Install(BepInEx.Logging.ManualLogSource log)
        {
            if (installed) return;
            installed = true;
            try
            {
                System.Reflection.MethodInfo target = null;
                System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
                foreach (System.Reflection.MethodInfo candidate in typeof(BepInEx.Logging.Logger).GetMethods(flags))
                {
                    if (candidate.Name != "InternalLogEvent") continue;
                    System.Reflection.ParameterInfo[] parameters = candidate.GetParameters();
                    if (parameters.Length == 2 && parameters[1].ParameterType == typeof(BepInEx.Logging.LogEventArgs))
                    {
                        target = candidate;
                        break;
                    }
                }
                if (target == null)
                {
                    log.LogWarning("console : filtre indisponible, lignes du jeu laissees telles quelles.");
                    return;
                }
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.quietconsole");
                harmony.Patch(target, prefix: new HarmonyLib.HarmonyMethod(typeof(QuietConsole).GetMethod("Prefix", flags)));
                log.LogInfo("console : filtre reseau actif.");
            }
            catch (Exception error)
            {
                log.LogWarning("console : filtre non installe (" + error.Message + ").");
            }
        }

        private static bool Prefix(object __0, BepInEx.Logging.LogEventArgs __1)
        {
            try
            {
                if (__1 == null) return true;
                string text = __1.Data as string;
                if (string.IsNullOrEmpty(text)) return true;
                for (int i = 0; i < Noise.Length; i++)
                {
                    if (text.IndexOf(Noise[i], StringComparison.OrdinalIgnoreCase) < 0) continue;
                    System.Threading.Interlocked.Increment(ref hidden);
                    return false;
                }
            }
            catch { }
            return true;
        }
    }

    public class BrandingScan : MonoBehaviour
    {
        public BrandingScan(IntPtr ptr) : base(ptr) { }

        private bool quietReported;

        private static readonly string[] LogoSprites =
        {
            "RecRoomLogo",
            "RecRoom_Logo",
            "RecRoomLogo_Sprite",
            "RecRoomLogo_Sprite_Shadow",
            "Illustration_RecRoomLogo",
            "RecRoom_Logo_SteamSplash_Tex",
            "RecRoom_Logo_OculusSplash_Tex",
            "RecRoom_Logo_VirtualRealitySplashImage"
        };

        private static readonly Color Accent = new Color(0.945f, 0.353f, 0.145f);
        private static readonly Color AccentDark = new Color(0.840f, 0.254f, 0.000f);
        private static readonly Color AccentLight = new Color(0.878f, 0.424f, 0.129f);

        private static Texture2D title;
        private static Sprite titleSprite;

        private readonly HashSet<string> seenPalettes = new HashSet<string>();
        private readonly HashSet<int> seenTextures = new HashSet<int>();
        private readonly List<Texture2D> queue = new List<Texture2D>();
        private readonly Dictionary<int, Texture2D> recoloured = new Dictionary<int, Texture2D>();
        private readonly Dictionary<int, Sprite> newSprites = new Dictionary<int, Sprite>();

        private float nextSweep;
        private float nextEnqueue;
        private int sweeps;
        private int palettePasses;
        private int texturesDone;
        private bool rebound;
        private bool diagnosed;
        private float lastDiagnose;
        private bool perfApplied;
        private float startedAt;
        private float nextRebind;
        private readonly HashSet<int> scaledImages = new HashSet<int>();
        private int loginAttempts;
        private float burstUntil;
        private int canvasSeen = -1;
        private float nextCanvasCheck;
        private bool sceneHooked;


        // Premiere fenetre de travail apres le lancement. Ensuite on ne recolore plus que
        // les ecrans qui arrivent (salves), pour ne pas payer de cout permanent.
        private const float Window = 40f;
        // Le demarrage du jeu charge ses propres bundles : convertir des textures pendant ce
        // temps faisait bugger le debut de partie. On laisse le jeu respirer 8 s.
        private const float StartDelay = 8f;
        // Au-dela, plus aucune conversion de texture ni rebind : le rendu prime (exigence
        // n1). La repeinte legere continue seule pour que le bleu tienne au clic.
        private const float BrandWindow = 20f;
        // Conversion des textures (orange -> bleu) et conversion de palette : coupees.
        // Chaque blit coute une frame entiere et c'est la source des gels. Le titre, la
        // configuration fps et la repeinte legere des boutons restent actifs.
        // Reglage de vitesse, lu dans RECBLUE_MODE.txt et relu toutes les 5 s :
        //   fluent   = aucune conversion de texture, fluidite maximale
        //   balanced = petites planches seulement (<= 512 px)
        //   branding = planches jusqu'a 2048 px (atlases RRUI), gels courts
        private const string ModeFile = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_MODE.txt";
        private static readonly string ModeFileDefault =
            "# REC BLUE - reglage du bleu (relu toutes les 5 s, sans recompiler)\n" +
            "# fluent   : textes seulement\n" +
            "# balanced : textes et panneaux\n" +
            "# branding : textes et panneaux (defaut)\n" +
            "mode=branding\n";
        private bool paintTextures = true;
        private int paintCap = 2048;
        private string paintMode = "";
        private float nextModeRead;
        private bool modeFileChecked;

        private void ReadMode()
        {
            float now = Time.realtimeSinceStartup;
            if (now < nextModeRead) return;
            nextModeRead = now + 5f;
            string mode = "branding";
            try
            {
                if (!modeFileChecked)
                {
                    modeFileChecked = true;
                    if (!System.IO.File.Exists(ModeFile)) System.IO.File.WriteAllText(ModeFile, ModeFileDefault);
                }
                if (System.IO.File.Exists(ModeFile))
                {
                    string text = System.IO.File.ReadAllText(ModeFile);
                    foreach (string raw in text.Split('\n'))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                        int equals = line.IndexOf('=');
                        if (equals < 0) continue;
                        if (!line.Substring(0, equals).Trim().Equals("mode", StringComparison.OrdinalIgnoreCase)) continue;
                        string value = line.Substring(equals + 1).Trim().ToLowerInvariant();
                        if (value.Length > 0) mode = value;
                    }
                }
            }
            catch { }
            // Consigne : le bleu ne reste que sur les textes et les panneaux. Plus de
            // conversion de textures ni d'icones — c'etait aussi le gel de 528 ms.
            bool textures = false;
            int cap = 512;
            if (mode == paintMode && textures == paintTextures && cap == paintCap) return;
            paintMode = mode;
            paintTextures = textures;
            paintCap = cap;
            BrandingPlugin.Trace.LogInfo("reglage : mode=" + paintMode + " (textures=" + paintTextures + ", planches<=" + paintCap + " px)");
        }
        // Mode sans branding, active par la presence d'un fichier : le jeu garde seulement
        // la configuration fps. Permet de savoir si un probleme vient de nos ecritures
        // (titre, couleurs, textures) ou du jeu lui-meme, sans recompiler.
        private const string SafeMarker = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_SAFE.txt";
        private static bool safeMode;
        private static bool safeChecked;

        private static Texture2D Load(string resource)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream(resource))
            {
                if (stream == null) return null;
                byte[] bytes = new byte[stream.Length];
                int read = 0;
                while (read < bytes.Length) read += stream.Read(bytes, read, bytes.Length - read);
                Texture2D texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (!ImageConversion.LoadImage(texture, bytes)) return null;
                texture.hideFlags = HideFlags.DontUnloadUnusedAsset;
                texture.name = resource;
                return texture;
            }
        }

        private void Prepare()
        {
            if (title != null) return;
            title = Load("RecBlueTitle.png");
            if (title == null) return;
            titleSprite = Sprite.Create(title, new Rect(0f, 0f, title.width, title.height), new Vector2(0.5f, 0.5f));
            titleSprite.name = "RecBlueTitle";
            BrandingPlugin.Trace.LogInfo("titre REC BLUE charge : " + title.width + "x" + title.height);
        }

        // ---------------------------------------------------------------- perf
        private static bool perfPriorityDone;
        private static float nextPerfAt;

        private void ApplyPerf()
        {
            // Le jeu remet parfois ses propres reglages (priorite, cadence) : on verifie
            // regulierement, sans ouvrir un handle de processus a chaque image.
            float now = Time.realtimeSinceStartup;
            if (now < nextPerfAt) return;
            nextPerfAt = now + 5f;
            try
            {
                // maxQueuedFrames n'est plus force a 1 : avec une seule image en file,
                // le CPU attend le GPU a chaque image et la cadence plafonne. On remet
                // la valeur par defaut du moteur (2) si une ancienne build l'avait laissee.
                try
                {
                    if (QualitySettings.maxQueuedFrames == 1)
                    {
                        QualitySettings.maxQueuedFrames = 2;
                        BrandingPlugin.Trace.LogInfo("perf : maxQueuedFrames 1 -> 2 (pipeline)");
                    }
                }
                catch { }
                if (QualitySettings.vSyncCount != 0)
                {
                    BrandingPlugin.Trace.LogInfo("perf : vsync " + QualitySettings.vSyncCount + " -> 0");
                    QualitySettings.vSyncCount = 0;
                }
            }
            catch { }
            try
            {
                // Plafond = frequence de l'ecran. Au-dela, le GPU fabrique des images que
                // l'ecran ne montre pas : chaleur et tearing sans fluidite en plus.
                int cap = ScreenCap();
                if (cap > 0 && Application.targetFrameRate != cap)
                {
                    BrandingPlugin.Trace.LogInfo("perf : plafond fps " + (Application.targetFrameRate < 0 ? "illimite" : Application.targetFrameRate.ToString()) + " -> " + cap + " (ecran " + cap + " Hz)");
                    Application.targetFrameRate = cap;
                }
            }
            catch { }
            try
            {
                // Le client remet sa priorite a Normal apres son initialisation : on la
                // remonte des qu'elle a bouge, sinon le gain ne tient pas la session.
                System.Diagnostics.Process current = System.Diagnostics.Process.GetCurrentProcess();
                if (current.PriorityClass != System.Diagnostics.ProcessPriorityClass.High)
                {
                    current.PriorityClass = System.Diagnostics.ProcessPriorityClass.High;
                    if (!perfPriorityDone)
                        BrandingPlugin.Trace.LogInfo("perf : priorite process = High");
                    else
                        BrandingPlugin.Trace.LogInfo("perf : priorite remise a High (le jeu l'avait baissee)");
                    perfPriorityDone = true;
                }
            }
            catch (Exception error) { if (!perfPriorityDone) BrandingPlugin.Trace.LogWarning("perf : priorite refusee (" + error.Message + ")"); }
        }

        // Frequence de l'ecran, relue a chaque passage : un changement d'affichage
        // (casque, moniteur secondaire, mode fenetre) doit se refleter dans le plafond.
        private static int ScreenCap()
        {
            int hz = 0;
            try { hz = Screen.currentResolution.refreshRate; } catch { }
            if (hz < 30 || hz > 500) hz = 0;
            return hz;
        }

        // ---------------------------------------------------------------- couleurs
        private static float Distance(Color a, Color b)
        {
            return Mathf.Abs(a.r - b.r) + Mathf.Abs(a.g - b.g) + Mathf.Abs(a.b - b.b);
        }

        private static bool IsRecOrange(Color c)
        {
            if (c.a < 0.02f) return false;
            if (Distance(c, Accent) < 0.20f) return true;
            if (Distance(c, AccentDark) < 0.20f) return true;
            if (Distance(c, AccentLight) < 0.20f) return true;
            if (!(c.r > 0.55f && c.g > 0.12f && c.g < 0.62f && c.b < 0.42f && (c.r - c.g) > 0.18f)) return false;
            // Orange #F1761F -> 0,71 ; orange clair #FFB03C -> 1,46 ; or #FFC83D -> 2,52 ;
            // jaune pur -> 5,4. Seuil a 1,6 : tout l'orange passe, l'or des etoiles reste.
            float warmth = c.g - c.b;
            float redness = c.r - c.g;
            if (redness <= 0f) return false;
            return warmth <= redness * 1.6f;
        }

        private static Color ToRecBlue(Color c)
        {
            float h, s, v;
            Color.RGBToHSV(c, out h, out s, out v);
            Color blue = Color.HSVToRGB(0.615f, Mathf.Clamp01(s * 1.05f + 0.10f), Mathf.Clamp01(v * 1.02f));
            blue.a = c.a;
            return blue;
        }

        private const Il2CppSystem.Reflection.BindingFlags All =
            Il2CppSystem.Reflection.BindingFlags.Public
            | Il2CppSystem.Reflection.BindingFlags.NonPublic
            | Il2CppSystem.Reflection.BindingFlags.Instance;

        private static bool IsCompound(string typeName)
        {
            switch (typeName)
            {
                case "":
                case "Single":
                case "Double":
                case "Int32":
                case "Int64":
                case "UInt32":
                case "Boolean":
                case "String":
                case "Color":
                case "Color32":
                case "Vector2":
                case "Vector3":
                case "Vector4":
                case "Quaternion":
                case "Rect":
                case "Sprite":
                case "Texture2D":
                case "Material":
                case "Object":
                case "GameObject":
                case "Transform":
                    return false;
                default:
                    return true;
            }
        }

        private bool ConvertObject(Il2CppSystem.Object value, int depth, ref int changed)
        {
            if (value == null || depth > 4 || changed > 2000) return false;
            Il2CppSystem.Type type;
            try { type = value.GetIl2CppType(); } catch { return false; }
            if (type == null) return false;
            Il2CppSystem.Reflection.FieldInfo[] fields;
            try { fields = type.GetFields(All); } catch { return false; }
            if (fields == null) return false;

            bool touched = false;
            foreach (Il2CppSystem.Reflection.FieldInfo field in fields)
            {
                if (field == null) continue;
                string fieldType = "";
                try { fieldType = field.FieldType != null ? field.FieldType.Name : ""; } catch { }

                if (fieldType == "Color")
                {
                    Color current;
                    try
                    {
                        Il2CppSystem.Object boxed = field.GetValue(value);
                        if (boxed == null) continue;
                        current = boxed.Unbox<Color>();
                    }
                    catch { continue; }
                    if (!IsRecOrange(current)) continue;
                    try
                    {
                        field.SetValue(value, ToRecBlue(current).BoxIl2CppObject());
                        changed++;
                        touched = true;
                    }
                    catch { }
                    continue;
                }

                if (fieldType.EndsWith("[]", StringComparison.Ordinal) && depth < 4)
                {
                    Il2CppSystem.Object boxed;
                    try { boxed = field.GetValue(value); } catch { continue; }
                    if (boxed == null) continue;
                    Il2CppSystem.Array array = null;
                    try { array = boxed.TryCast<Il2CppSystem.Array>(); } catch { }
                    if (array == null) continue;
                    int length = 0;
                    try { length = array.Length; } catch { }
                    for (int i = 0; i < length && i < 120; i++)
                    {
                        Il2CppSystem.Object element;
                        try { element = array.GetValue(i); } catch { continue; }
                        if (element == null) continue;
                        if (!ConvertObject(element, depth + 1, ref changed)) continue;
                        try { array.SetValue(element, i); touched = true; } catch { }
                    }
                    continue;
                }

                if (depth < 4 && IsCompound(fieldType))
                {
                    bool valueType = true;
                    try
                    {
                        Il2CppSystem.Type childType = field.FieldType;
                        if (childType != null) valueType = childType.IsValueType;
                    }
                    catch { valueType = true; }
                    if (valueType) continue;
                    Il2CppSystem.Object child;
                    try { child = field.GetValue(value); } catch { continue; }
                    if (child == null) continue;
                    if (ConvertObject(child, depth + 1, ref changed)) touched = true;
                }
            }
            return touched;
        }

        // Dump unique des entrees de palette : c'est le seul moyen de savoir quelle entree
        // colore le bouton DONE et les cercles de selection, qui restent orange.
        private bool paletteDumped;

        private void DumpPalette(ScriptableObject asset)
        {
            if (paletteDumped) return;
            paletteDumped = true;
            try
            {
                Il2CppSystem.Type type = asset.GetIl2CppType();
                if (type == null) return;
                Il2CppSystem.Reflection.FieldInfo[] fields = type.GetFields(All);
                if (fields == null) return;
                foreach (Il2CppSystem.Reflection.FieldInfo field in fields)
                {
                    if (field == null) continue;
                    string fieldType = "";
                    try { fieldType = field.FieldType != null ? field.FieldType.Name : ""; } catch { }
                    if (fieldType != "Color") continue;
                    string name = "?";
                    try { name = field.Name ?? "?"; } catch { }
                    Color entry;
                    try
                    {
                        Il2CppSystem.Object boxed = field.GetValue(asset);
                        if (boxed == null) continue;
                        entry = boxed.Unbox<Color>();
                    }
                    catch { continue; }
                }
            }
            catch { }
        }

        private void PalettePass()
        {
            int changed = 0;
            string touchedTypes = "";
            try
            {
                ScriptableObject[] assets = Resources.FindObjectsOfTypeAll<ScriptableObject>();
                int scanned = 0;
                foreach (ScriptableObject asset in assets)
                {
                    if (scanned++ > 400) break;
                    if (asset == null) continue;
                    string typeName;
                    try
                    {
                        Il2CppSystem.Type type = asset.GetIl2CppType();
                        typeName = type != null ? (type.FullName ?? "?") : "?";
                    }
                    catch { continue; }

                    // Les boutons et barres sont dessines avec la couleur de la palette, pas
                    // dans leur texture (0 pixel orange dans les planches). Et le jeu
                    // reapplique son theme apres nos passes : memoriser les assets deja vus
                    // remettait l'orange definitivement, donc on reconvertit a chaque salve.
                    if (typeName.IndexOf("RRUI", StringComparison.OrdinalIgnoreCase) < 0
                        && typeName.IndexOf("Palette", StringComparison.OrdinalIgnoreCase) < 0
                        && typeName.IndexOf("Theme", StringComparison.OrdinalIgnoreCase) < 0
                        && typeName.IndexOf("ColorScheme", StringComparison.OrdinalIgnoreCase) < 0)
                        continue;

                    if (typeName.IndexOf("Palette", StringComparison.OrdinalIgnoreCase) >= 0) DumpPalette(asset);
                    int before = changed;
                    try { ConvertObject(asset, 0, ref changed); } catch { }
                    if (changed > before && touchedTypes.IndexOf(typeName, StringComparison.Ordinal) < 0)
                        touchedTypes += typeName + " ";
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("palette : " + error.Message); }
            if (changed > 0)
                BrandingPlugin.Trace.LogInfo("palette : " + changed + " couleur(s) convertie(s) en bleu [" + touchedTypes.Trim() + "]");
        }

        // Une passe complete enumerait tous les Graphic/Selectable dans une seule frame :
        // c'est la chute de fps ressentie. On etale le meme travail sur plusieurs frames,
        // 2 ms maximum par frame, et on relance des qu'un clic reconstruit le theme.
        private Graphic[] paintGraphics = new Graphic[0];
        private Selectable[] paintSelectables = new Selectable[0];
        private int paintIndex;
        private float paintUntil;
        private int slicedChanged;
        private int slicedCanvas;
        // Temoins : elements deja passes en bleu. S'ils redeviennent orange, c'est que le
        // jeu a reconstruit son theme (au clic) : on repeint tout de suite, sans attendre
        // la passe de securite. Input n'est pas reference dans ce projet, ce signal le
        // remplace et ne coute que quelques lectures de propriete.
        private readonly List<Graphic> canaries = new List<Graphic>();
        // Textes mis de cote : ils passent avant le balayage complet.
        private readonly List<Graphic> textGraphics = new List<Graphic>();
        private int textIndex;
        // Boutons : le jeu remet son ColorBlock de base au clic, ce qui rend l'orange. On les
        // suit individuellement pour les reconvertir immediatement, sans attendre une passe.
        private readonly List<Selectable> selectableCanaries = new List<Selectable>();
        private float nextCanaryCheck;
        private float nextButtonFixLog;
        private GameObject lastSelected;

        // ------------------------------------------------------------- sonde montre
        // RECBLUE_DUMP.txt : releve les objets orange (chemin, type, sprite, texture) et
        // horodate chaque gel de frame en disant ce que le plugin faisait juste avant.
        // Sert a savoir qui dessine le bandeau orange de la montre et d'ou vient le gel.
        private const string DumpMarker = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_DUMP.txt";
        private float nextDumpCheck;
        private float nextDumpAt;
        private int dumpRuns;
        private int enqueueRuns;
        private int spikeLogs;
        private bool frameBlit;
        private bool frameEnqueue;
        private bool frameRefresh;
        private bool frameSweep;
        private int deepSweeps;
        // Negatif : la toute premiere passe doit partir au demarrage, quand le logo du
        // chargement existe encore. Les suivantes respectent le plancher de 8 s.
        private float lastSweepAt = -30f;
        private bool titleSwapped;

        private string FrameWork()
        {
            // Les drapeaux decrivent la frame precedente : c'est elle qui a rallonge le delai
            // mesure par Time.unscaledDeltaTime.
            string work = "";
            if (frameBlit) work += "blit texture";
            if (frameEnqueue) work += (work.Length > 0 ? " + " : "") + "enumeration Image";
            if (frameRefresh) work += (work.Length > 0 ? " + " : "") + "refresh Graphic";
            if (frameSweep) work += (work.Length > 0 ? " + " : "") + "sweep sprites";
            return work.Length == 0 ? "aucun travail du plugin" : work;
        }

        private static string PathOf(Transform start)
        {
            string path = "";
            Transform current = start;
            int guard = 0;
            while (current != null && guard++ < 8)
            {
                path = current.name + (path.Length > 0 ? "/" + path : "");
                current = current.parent;
            }
            return path;
        }

        private void DumpOrangeOnce()
        {
            int total = 0;
            try
            {
                Canvas[] canvases = Resources.FindObjectsOfTypeAll<Canvas>();
                total = canvases.Length;
                int shown = 0;
                foreach (Canvas canvas in canvases)
                {
                    if (canvas == null || !canvas.isActiveAndEnabled) continue;
                    if (shown++ >= 12) break;
                }
            }
            catch { }

            int found = 0;
            try
            {
                Graphic[] graphics = Resources.FindObjectsOfTypeAll<Graphic>();
                foreach (Graphic graphic in graphics)
                {
                    if (graphic == null || !graphic.isActiveAndEnabled) continue;
                    Color color;
                    try { color = graphic.color; } catch { continue; }
                    if (!IsRecOrange(color)) continue;

                    string extra = "";
                    Image image = graphic as Image;
                    if (image != null)
                    {
                        Sprite sprite = null;
                        try { sprite = image.sprite; } catch { }
                        if (sprite != null)
                        {
                            Texture2D texture = null;
                            try { texture = sprite.texture; } catch { }
                            extra = " | sprite=" + (sprite.name ?? "?") + (texture != null ? " tex=" + texture.width + "x" + texture.height : "");
                        }
                        else extra = " | sans sprite (a plat)";
                    }
                    else
                    {
                        Text label = graphic as Text;
                        if (label != null) extra = " | texte=\"" + (label.text ?? "") + "\"";
                        else extra = " | " + graphic.GetType().Name + " sans sprite";
                    }
                    if (++found >= 40) break;
                }
            }
            catch { }

            // Textes : contenu et couleur reels. Sert a verifier que les titres de pieces
            // sont bien des composants texte et a voir la couleur qu'ils portent.
            int texts = 0;
            try
            {
                Text[] labels = Resources.FindObjectsOfTypeAll<Text>();
                foreach (Text label in labels)
                {
                    if (label == null || !label.isActiveAndEnabled) continue;
                    string content = "";
                    try { content = label.text ?? ""; } catch { }
                    Color color = Color.white;
                    try { color = label.color; } catch { }
                    if (++texts >= 200) break;
                }
                TMPro.TextMeshProUGUI[] tmps = Resources.FindObjectsOfTypeAll<TMPro.TextMeshProUGUI>();
                int tmpCount = 0;
                foreach (TMPro.TextMeshProUGUI tmp in tmps)
                {
                    if (tmp == null || !tmp.isActiveAndEnabled) continue;
                    string content = "";
                    try { content = tmp.text ?? ""; } catch { }
                    Color color = Color.white;
                    try { color = tmp.color; } catch { }
                    if (++tmpCount >= 400) break;
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogInfo("sonde textes : " + error.Message); }

            // Un bandeau orange n'est pas forcement un Graphic orange : c'est souvent une
            // Image au teint blanc qui affiche une planche orange. On liste donc les Image
            // actives avec leur sprite, pour retrouver celle de la montre.
            int listed = 0;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null || !image.isActiveAndEnabled) continue;
                    Sprite sprite = null;
                    try { sprite = image.sprite; } catch { }
                    if (sprite == null) continue;
                    Texture2D texture = null;
                    try { texture = sprite.texture; } catch { }
                    Color tint = Color.white;
                    try { tint = image.color; } catch { }
                    if (++listed >= 80) break;
                }
            }
            catch { }
        }

        // Le clic sur un bouton reconstruit ses couleurs de base. La selection d'UI est le
        // seul signal fiable disponible (Input n'est pas reference) : des qu'elle change,
        // on relance une repeinte immediate au lieu d'attendre la passe suivante.
        private void CheckSelection()
        {
            if (safeMode) return;
            try
            {
                UnityEngine.EventSystems.EventSystem system = UnityEngine.EventSystems.EventSystem.current;
                if (system == null) return;
                GameObject current = system.currentSelectedGameObject;
                if (current == lastSelected) return;
                lastSelected = current;
                if (current == null) return;
                paintIndex = 0;
                nextPassAt = 0f;
                paintUntil = 0f;
                RequestPaint(3f);
            }
            catch { }
        }
        private float nextPassAt;
        private float nextGraphicsRefresh;
        private float nextPaletteAt;
        private bool idleFlagRead;
        private bool idleForced;
        private bool idleLogged;
        // Un blit de texture trop lent bloque une frame entiere : apres un tel blit on
        // met la conversion en pause, sinon le jeu gele par vagues.
        private float texturePauseUntil;

        private void CheckCanaries(float now)
        {
            if (safeMode) return;
            if (now < nextCanaryCheck) return;
            // 80 ms : le theme RRUI remet ses couleurs tres vite apres un clic ; a 250 ms
            // l'utilisateur voyait l'orange revenir avant chaque correction.
            nextCanaryCheck = now + 0.12f;

            // 1) Boutons suivis : reconversion immediate du ColorBlock.
            int fixedButtons = 0;
            for (int i = 0; i < selectableCanaries.Count; i++)
            {
                Selectable selectable = selectableCanaries[i];
                if (selectable == null) continue;
                try
                {
                    ColorBlock block = selectable.colors;
                    bool touched = false;
                    if (IsRecOrange(block.normalColor)) { block.normalColor = ToRecBlue(block.normalColor); touched = true; }
                    if (IsRecOrange(block.highlightedColor)) { block.highlightedColor = ToRecBlue(block.highlightedColor); touched = true; }
                    if (IsRecOrange(block.pressedColor)) { block.pressedColor = ToRecBlue(block.pressedColor); touched = true; }
                    if (IsRecOrange(block.selectedColor)) { block.selectedColor = ToRecBlue(block.selectedColor); touched = true; }
                    if (IsRecOrange(block.disabledColor)) { block.disabledColor = ToRecBlue(block.disabledColor); touched = true; }
                    if (!touched) continue;
                    selectable.colors = block;
                    fixedButtons++;
                }
                catch { }
            }
            if (fixedButtons > 0 && now >= nextButtonFixLog)
            {
                nextButtonFixLog = now + 5f;
            }

            // 2) Images suivies : meme logique, sans ColorBlock.
            bool reverted = false;
            for (int i = 0; i < canaries.Count; i++)
            {
                Graphic canary = canaries[i];
                if (canary == null) continue;
                try
                {
                    if (IsRecOrange(canary.color)) { canary.color = ToRecBlue(canary.color); reverted = true; }
                }
                catch { }
            }
            // Le jeu reconstruit parfois son logo juste apres l'avoir affiche : on le remet
            // en place toutes les 120 ms, sinon l'orange revient entre deux balayages.
            for (int i = 0; i < logoCanaries.Count; i++)
            {
                Image logo = logoCanaries[i];
                if (logo == null) continue;
                try
                {
                    if (logo.sprite != titleSprite)
                    {
                        logo.sprite = titleSprite;
                        logo.preserveAspect = true;
                        reverted = true;
                    }
                }
                catch { }
            }
            if (!reverted && fixedButtons == 0) return;
            RequestPaint(2f);
        }

        private void RequestPaint(float seconds)
        {
            float until = Time.realtimeSinceStartup + seconds;
            if (until > paintUntil) paintUntil = until;
        }

        // Seuls elements autorises a passer en bleu : les textes et, si le mode le permet,
        // les panneaux (fond de montre, tableaux, cartes). Boutons et icones restent au jeu.

        // Consigne : le bleu ne reste QUE sur le texte — titres de pieces, noms d'objets,
        // textes du MakerPen. Plus aucun fond, bouton ni icone.
        // Textes partout (titres, objets, MakerPen) + les aplats du seul tableau d'accueil.
        private static bool IsKept(Graphic graphic)
        {
            if (graphic is Text) return true;
            string type = graphic.GetType().Name;
            if (type.StartsWith("TextMeshPro", StringComparison.Ordinal) || type.IndexOf("TMP_", StringComparison.Ordinal) >= 0) return true;
            return IsBoard(graphic.transform);
        }

        // Le tableau de la chambre : tout ce qui vit sous un ancetre CommunityBoard.
        private static bool IsBoard(Transform start)
        {
            Transform current = start;
            int guard = 0;
            while (current != null && guard++ < 12)
            {
                string name = current.name ?? "";
                if (name.IndexOf("CommunityBoard", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (name.IndexOf("tableau", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                current = current.parent;
            }
            return false;
        }

        // Textes 3D du MakerPen : TextMesh n'est pas un Graphic, il a sa propre couleur.
        private void PaintTextMeshes()
        {
            try
            {
                TextMesh[] meshes = UnityEngine.Object.FindObjectsOfType<TextMesh>();
                int painted = 0;
                foreach (TextMesh mesh in meshes)
                {
                    if (mesh == null) continue;
                    Color color;
                    try { color = mesh.color; } catch { continue; }
                    if (!IsRecOrange(color)) continue;
                    try { mesh.color = ToRecBlue(color); painted++; } catch { }
                }
                if (painted > 0) BrandingPlugin.Trace.LogInfo("textes 3D : " + painted + " element(s) en bleu.");
            }
            catch { }
        }

        private void PaintSlice()
        {
            if (safeMode) return;
            float now = Time.realtimeSinceStartup;
            if (now > paintUntil || now < nextPassAt) return;
            System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
            int changed = 0;
            int canvasChanged = 0;
            // Re-enumerer tous les Graphic a chaque passe coutait le framerate (12 fps
            // mesure) : on garde la liste 2 s et on n'enchainne pas les passes.
            // L'enumeration complete des Graphic a ete mesuree a 2,3 s de gel (sonde) : on
            // ne la lance plus que sur une frame saine, et deux fois moins souvent.
            if (paintIndex == 0 && now >= nextGraphicsRefresh && Time.unscaledDeltaTime < 0.03f)
            {
                nextGraphicsRefresh = now + 8f;
                frameRefresh = true;
                // Objets actifs uniquement : Resources.FindObjectsOfTypeAll parcourt aussi tous
                // les gabarits charges en memoire et a ete mesure a 2,3 s de gel.
                System.Diagnostics.Stopwatch scan = System.Diagnostics.Stopwatch.StartNew();
                try { paintGraphics = UnityEngine.Object.FindObjectsOfType<Graphic>(); } catch { paintGraphics = new Graphic[0]; }
                if (scan.ElapsedMilliseconds >= 20)
                    BrandingPlugin.Trace.LogInfo("perf : enumeration graphic " + scan.ElapsedMilliseconds + " ms (" + paintGraphics.Length + " objets)");
                // On isole les textes une fois pour toutes : ils sont peu nombreux et ce sont
                // eux que l'on veut bleus.
                textGraphics.Clear();
                textIndex = 0;
                for (int i = 0; i < paintGraphics.Length; i++)
                {
                    Graphic candidate = paintGraphics[i];
                    if (candidate != null && IsKept(candidate)) textGraphics.Add(candidate);
                }
                // Boutons laisses au jeu (consigne : textes et panneaux seulement).
                paintSelectables = new Selectable[0];
            }
            // Priorite aux textes : le balayage complet parcourt des milliers de Graphic et
            // les titres de pieces restaient rouges en attendant leur tour.
            while (textIndex < textGraphics.Count)
            {
                if (watch.Elapsed.TotalMilliseconds > 0.30) break;
                Graphic text = textGraphics[textIndex++];
                if (text == null) continue;
                try
                {
                    Color current = text.color;
                    if (!IsRecOrange(current)) continue;
                    text.color = ToRecBlue(current);
                    changed++;
                    if (canaries.Count < 200 && !canaries.Contains(text)) canaries.Add(text);
                }
                catch { }
            }
            int total = paintGraphics.Length + paintSelectables.Length;
            while (paintIndex < total)
            {
                // 2 ms par frame coutait visiblement le framerate a 240 Hz : 0,5 ms suffit
                // pour finir une passe en une seconde sans jamais bloquer une frame.
                if (watch.Elapsed.TotalMilliseconds > 0.30) break;
                int index = paintIndex;
                if (index < paintGraphics.Length)
                {
                    Graphic graphic = paintGraphics[index];
                    if (graphic != null)
                    {
                        Color current;
                        try { current = graphic.color; } catch { current = Color.white; }
                        if (IsRecOrange(current) && IsKept(graphic))
                        {
                            try
                            {
                                graphic.color = ToRecBlue(current);
                                changed++;
                                if (canaries.Count < 200 && !canaries.Contains(graphic)) canaries.Add(graphic);
                            }
                            catch { }
                        }
                        try
                        {
                            CanvasRenderer renderer = graphic.canvasRenderer;
                            if (renderer != null && IsKept(graphic))
                            {
                                Color vertex = renderer.GetColor();
                                if (IsRecOrange(vertex))
                                {
                                    renderer.SetColor(ToRecBlue(vertex));
                                    canvasChanged++;
                                }
                            }
                        }
                        catch { }
                    }
                }
                else
                {
                    Selectable selectable = paintSelectables[index - paintGraphics.Length];
                    if (selectable != null)
                    {
                        bool haveBlock = true;
                        ColorBlock block = default(ColorBlock);
                        try { block = selectable.colors; } catch { haveBlock = false; }
                        if (haveBlock)
                        {
                            bool touched = false;
                            if (IsRecOrange(block.normalColor)) { block.normalColor = ToRecBlue(block.normalColor); touched = true; }
                            if (IsRecOrange(block.highlightedColor)) { block.highlightedColor = ToRecBlue(block.highlightedColor); touched = true; }
                            if (IsRecOrange(block.pressedColor)) { block.pressedColor = ToRecBlue(block.pressedColor); touched = true; }
                            if (IsRecOrange(block.selectedColor)) { block.selectedColor = ToRecBlue(block.selectedColor); touched = true; }
                            if (IsRecOrange(block.disabledColor)) { block.disabledColor = ToRecBlue(block.disabledColor); touched = true; }
                            if (touched)
                            {
                                try
                                {
                                    selectable.colors = block;
                                    changed++;
                                    if (selectableCanaries.Count < 400 && !selectableCanaries.Contains(selectable)) selectableCanaries.Add(selectable);
                                    Graphic target = null;
                                    try { target = selectable.image; } catch { }
                                    if (target != null && canaries.Count < 200 && !canaries.Contains(target)) canaries.Add(target);
                                }
                                catch { }
                            }
                        }
                    }
                }
                paintIndex++;
            }
            slicedChanged += changed;
            slicedCanvas += canvasChanged;
            if (paintIndex >= total)
            {
                paintIndex = 0;
                textIndex = 0;
                nextPassAt = now + 2f;
                PaintTextMeshes();
                if (slicedChanged > 0 || slicedCanvas > 0)
                    BrandingPlugin.Trace.LogInfo("teintes : " + slicedChanged + " element(s) passe(s) en bleu, " + slicedCanvas + " canvas (lisse).");
                slicedChanged = 0;
                slicedCanvas = 0;
            }
        }

        private void TintPass()
        {
            int changed = 0;
            int canvasChanged = 0;

            try
            {
                Graphic[] graphics = Resources.FindObjectsOfTypeAll<Graphic>();
                foreach (Graphic graphic in graphics)
                {
                    if (graphic == null) continue;
                    Color current;
                    try { current = graphic.color; } catch { current = Color.white; }
                    if (IsRecOrange(current))
                    {
                        try { graphic.color = ToRecBlue(current); changed++; } catch { }
                    }

                    // La couleur reellement dessinee peut venir du CanvasRenderer (vertex color)
                    // et non de Graphic.color : c'est la que vivent les boutons RRUI.
                    try
                    {
                        CanvasRenderer renderer = graphic.canvasRenderer;
                        if (renderer == null) continue;
                        Color vertex = renderer.GetColor();
                        if (!IsRecOrange(vertex)) continue;
                        renderer.SetColor(ToRecBlue(vertex));
                        canvasChanged++;
                    }
                    catch { }
                }
            }
            catch { }


            try
            {
                Selectable[] selectables = UnityEngine.Object.FindObjectsOfType<Selectable>();
                foreach (Selectable selectable in selectables)
                {
                    if (selectable == null) continue;
                    ColorBlock block;
                    try { block = selectable.colors; } catch { continue; }
                    bool touched = false;
                    try
                    {
                        if (IsRecOrange(block.normalColor)) { block.normalColor = ToRecBlue(block.normalColor); touched = true; }
                        if (IsRecOrange(block.highlightedColor)) { block.highlightedColor = ToRecBlue(block.highlightedColor); touched = true; }
                        if (IsRecOrange(block.pressedColor)) { block.pressedColor = ToRecBlue(block.pressedColor); touched = true; }
                        if (IsRecOrange(block.selectedColor)) { block.selectedColor = ToRecBlue(block.selectedColor); touched = true; }
                        if (IsRecOrange(block.disabledColor)) { block.disabledColor = ToRecBlue(block.disabledColor); touched = true; }
                    }
                    catch { }
                    if (!touched) continue;
                    try { selectable.colors = block; changed++; } catch { }
                }
            }
            catch { }

            if (changed > 0) BrandingPlugin.Trace.LogInfo("teintes : " + changed + " element(s) passe(s) en bleu.");
        }

        // ---------------------------------------------------------------- textures
        private static bool IsWarmColour(Color32 pixel)
        {
            if (pixel.a < 8) return false;
            int max = Mathf.Max(pixel.r, Mathf.Max(pixel.g, pixel.b));
            int min = Mathf.Min(pixel.r, Mathf.Min(pixel.g, pixel.b));
            if (max < 90) return false;
            if (max - min < 30) return false;          // gris / blanc : on ne touche pas
            if (pixel.r < pixel.g || pixel.g < pixel.b) return false;  // froid : on ne touche pas
            // Equivalent entier de "teinte < 0,14" : 100*(g-b) < 84*(r-b).
            // Un RGBToHSV par pixel sur une texture 1024x1024 = 1 million de conversions,
            // et ce sont ces blits qui gelaient le jeu 200-600 ms (mesure A/B).
            // Rapport (g-b)/(r-b) : orange 0,41, orange clair 0,60, or 0,72, jaune 0,84.
            // Seuil a 62 : l'orange passe, l'or des etoiles de notation reste dore.
            return 100 * ((int)pixel.g - pixel.b) < 62 * ((int)pixel.r - pixel.b);
        }

        private Texture2D RecolourTexture(Texture2D source)
        {
            int w = source.width;
            int h = source.height;
            // Les planches d'interface du jeu depassent souvent 4096 px : les ignorer
            // laissait les barres et les aplats en orange.
            // Les planches d'interface mesurees font 1024x1024 ou 512x512. Un atlas plus
            // grand coute des centaines de ms en un seul blit (mesure : 4-7 fps au
            // demarrage), et le budget par frame ne peut pas le decouper. On l'ignore.
            // Plafond en pixels, pas en cote : un bandeau d'en-tete tres large et bas
            // (2048x256) etait refuse par la limite de cote et restait orange.
            // Le budget vient du fichier de reglage : 512 (balanced) ou 1024 (branding).
            if (w < 16 || h < 16 || (long)w * h > (long)paintCap * paintCap)
            {
                return null;
            }

            Texture2D copy = null;
            RenderTexture target = null;
            RenderTexture previous = RenderTexture.active;
            try
            {
                target = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(source, target);
                RenderTexture.active = target;
                copy = new Texture2D(w, h, TextureFormat.RGBA32, false);
                copy.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                copy.Apply();
            }
            catch { }
            finally
            {
                RenderTexture.active = previous;
                if (target != null) RenderTexture.ReleaseTemporary(target);
            }
            if (copy == null) return null;

            Color32[] pixels = copy.GetPixels32();
            int hit = 0;
            for (int i = 0; i < pixels.Length; i++)
            {
                if (!IsWarmColour(pixels[i])) continue;
                Color32 warm = pixels[i];
                // Remappage lineaire rouge -> bleu : trois multiplications par pixel au lieu
                // d'un RGBToHSV + HSVToRGB. C'est ce couple qui faisait les gels de 200 ms
                // sur les planches 1024, donc le cout principal de la montre.
                // (241,118,31) -> (5,83,228) ; (255,200,120) -> (21,134,242).
                int nr = (int)(warm.b * 0.18f);
                int ng = (int)(warm.g * 0.62f + 10f);
                int nb = (int)(warm.r * 0.95f);
                pixels[i] = new Color32(
                    (byte)(nr > 255 ? 255 : nr),
                    (byte)(ng > 255 ? 255 : ng),
                    (byte)(nb > 255 ? 255 : nb),
                    warm.a);
                hit++;
            }

            if (hit < pixels.Length / 300)
            {
                BrandingPlugin.Trace.LogInfo("texture ignoree (peu d'orange " + hit + "/" + pixels.Length + ") : " + source.name);
                Destroy(copy);
                return null;
            }
            copy.Apply();
            copy.name = source.name + "_recblue";
            BrandingPlugin.Trace.LogInfo("texture : " + source.name + " " + w + "x" + h + " -> " + hit + " pixel(s)");
            return copy;
        }

        private void Enqueue()
        {
            // Une enumeration complete des Image coute une frame quand l'interface vient de
            // s'ouvrir : on la reporte tant que le jeu n'est pas revenu au calme.
            if (Time.unscaledDeltaTime > 0.05f)
            {
                nextEnqueue = Time.realtimeSinceStartup + 0.5f;
                return;
            }
            frameEnqueue = true;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    Texture2D texture;
                    try { texture = sprite.texture; } catch { continue; }
                    if (texture == null || title != null && texture == title) continue;
                    string name;
                    try { name = texture.name ?? ""; } catch { name = ""; }
                    if (name == "RecBlueTitle.png" || name.EndsWith("_recblue", StringComparison.Ordinal)) continue;
                    int id;
                    try { id = texture.GetInstanceID(); } catch { continue; }
                    if (!seenTextures.Add(id)) continue;
                    queue.Add(texture);
                }
            }
            catch { }
        }

        private void ProcessQueue()
        {
            if (queue.Count == 0) return;
            if (Time.realtimeSinceStartup < texturePauseUntil) return;
            // Une frame deja lente (animation de la montre, chargement) ne doit pas recevoir
            // un blit supplementaire : on le reporte a la frame suivante.
            if (Time.unscaledDeltaTime > 0.04f) return;
            // Une conversion = un blit RenderTexture + lecture de pixels : plusieurs dans la
            // meme frame font chuter le framerate d'un coup. Budget de 6 ms par frame.
            System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
            int done = 0;
            while (queue.Count > 0)
            {
                Texture2D source = queue[0];
                queue.RemoveAt(0);
                if (source == null) continue;
                try
                {
                    Texture2D copy = RecolourTexture(source);
                    if (copy != null)
                    {
                        int id = source.GetInstanceID();
                        recoloured[id] = copy;
                        texturesDone++;
                        frameBlit = true;
                    }
                }
                catch (Exception error) { BrandingPlugin.Trace.LogWarning("texture : " + error.Message); }
                done++;
                if (watch.Elapsed.TotalMilliseconds >= 60.0)
                {
                    // Blit lourd : on laisse le jeu respirer pour que les gels restent
                    // espaces au lieu de s'enchainer.
                    texturePauseUntil = Time.realtimeSinceStartup + 3f;
                    break;
                }
                if (done >= 1 && watch.Elapsed.TotalMilliseconds >= 1.5) break;
            }
        }

        private void RebindSprites()
        {
            if (recoloured.Count == 0) return;
            int swapped = 0;
            int packedSkipped = 0;
            int rawSwapped = 0;

            // RawImage : on remplace juste la texture, aucun sprite a reconstruire.
            try
            {
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in raws)
                {
                    // Les objets inactifs representent des centaines de gabarits : les
                    // parcourir a chaque rebind coutait les gels mesures (433 ms). Ils seront
                    // traites quand ils deviendront actifs.
                    if (raw == null || !raw.isActiveAndEnabled) continue;
                    Texture currentTex;
                    try { currentTex = raw.texture; } catch { continue; }
                    if (currentTex == null) continue;
                    Texture2D replacement;
                    if (!recoloured.TryGetValue(currentTex.GetInstanceID(), out replacement)) continue;
                    try { raw.texture = replacement; rawSwapped++; } catch { }
                }
            }
            catch { }

            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null || !image.isActiveAndEnabled) continue;
                    Sprite current;
                    try { current = image.sprite; } catch { continue; }
                    if (current == null) continue;
                    bool packed = false;
                    try { packed = current.packed; } catch { }
                    Texture2D texture;
                    try { texture = current.texture; } catch { continue; }
                    if (texture == null) continue;
                    Texture2D replacement;
                    if (!recoloured.TryGetValue(texture.GetInstanceID(), out replacement)) continue;

                    int key = current.GetInstanceID();
                    Sprite sprite;
                    if (!newSprites.TryGetValue(key, out sprite))
                    {
                        try
                        {
                            // Un sprite d'atlas se decrit dans l'espace de l'atlas (textureRect),
                            // pas dans l'espace de l'image d'origine (rect) : utiliser rect ici
                            // affichait une mauvaise zone de l'atlas.
                            Rect region = packed ? current.textureRect : current.rect;
                            if (region.width < 2f || region.height < 2f) { packedSkipped++; continue; }
                            Vector2 pivot;
                            if (packed)
                            {
                                Vector2 offset = current.textureRectOffset;
                                pivot = new Vector2(
                                    (offset.x + current.pivot.x) / region.width,
                                    (offset.y + current.pivot.y) / region.height);
                            }
                            else
                            {
                                pivot = new Vector2(
                                    current.pivot.x / region.width,
                                    current.pivot.y / region.height);
                            }
                            sprite = Sprite.Create(replacement, region, pivot, current.pixelsPerUnit, 0, SpriteMeshType.FullRect, current.border);
                            sprite.name = current.name;
                            newSprites[key] = sprite;
                        }
                        catch { packedSkipped++; continue; }
                    }
                    try { image.sprite = sprite; swapped++; } catch { }
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("sprite : " + error.Message); }
            BrandingPlugin.Trace.LogInfo("textures : " + texturesDone + " recoloree(s), " + swapped + " sprite(s) remplace(s), " + rawSwapped + " rawimage(s), " + packedSkipped + " sprite(s) d'atlas laisse(s).");
        }

        // ---------------------------------------------------------------- boucle
        // Diagnostic : identifie les grands elements d'interface et leur source de couleur
        // (texture ou teinte), pour savoir ou vit encore l'orange.
        private void DiagnoseLarge(float now)
        {
            if (diagnosed && now - lastDiagnose < 15f) return;
            diagnosed = true;
            lastDiagnose = now;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Rect rect;
                    try { rect = image.rectTransform.rect; } catch { continue; }
                    if (rect.width < 260f || rect.height < 60f) continue;
                    string go = "?";
                    try { go = image.gameObject != null ? image.gameObject.name : "?"; } catch { }
                    Sprite sprite;
                    string spriteName = "aucun";
                    string textureName = "aucun";
                    bool packed = false;
                    try
                    {
                        sprite = image.sprite;
                        if (sprite != null)
                        {
                            spriteName = sprite.name ?? "?";
                            packed = sprite.packed;
                            if (sprite.texture != null) textureName = sprite.texture.name ?? "?";
                        }
                    }
                    catch { }
                    Color colour = new Color(-1f, -1f, -1f, -1f);
                    try { colour = image.color; } catch { }
                    string state = IsRecOrange(colour) ? " TEINTE-ORANGE" : "";
                }
            }
            catch { }
        }

        // ---------------------------------------------------------------- fond de login
        // Le fond orange a motifs n'est ni une couleur d'interface ni une sprite classique.
        // On le retrouve en cherchant la grande texture dominee par des pixels chauds, puis on
        // remplace cette texture par le fond bleu prepar par l'utilisateur.
        private bool backdropDone;
        private bool backdropLoadTried;
        private Sprite backdropSprite;
        private GameObject backdropObject;

        // Le fond orange du login ne vient ni des couleurs ni des textures d'interface
        // identifiables. Plutot que de le chercher indefiniment, on pose le fond bleu
        // prepare en premier enfant du canvas qui porte le bouton JOUER : il passe
        // derriere tout le panneau, disparait quand ce canvas s'en va, et ne coute rien.
        private void BackdropOverlay()
        {
            if (!backdropLoadTried)
            {
                backdropLoadTried = true;
                Texture2D art = Load("RecLoginBackdrop.png");
                if (art != null)
                {
                    art.name = "RecLoginBackdrop";
                    backdropSprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                    backdropSprite.name = "RecLoginBackdropSprite";
                }
                else BrandingPlugin.Trace.LogWarning("fond : image absente du plugin");
            }
            if (backdropSprite == null) return;

            Canvas target = null;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { name = ""; }
                    if (name.IndexOf("Primary_Button", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    try { target = image.canvas; } catch { }
                    if (target == null) BrandingPlugin.Trace.LogInfo("fond : canvas null pour " + name);
                    if (target == null) { try { target = image.GetComponentInParent<Canvas>(); } catch { } }
                    if (target == null) { try { target = image.transform.root.GetComponentInChildren<Canvas>(); } catch { } }
                    if (target != null)
                    {
                        BrandingPlugin.Trace.LogInfo("fond : canvas du login trouve (" + name + ")");
                        break;
                    }
                }
            }
            catch { }

            if (target == null || target.gameObject == null)
            {
                if (backdropObject != null)
                {
                    try { Destroy(backdropObject); } catch { }
                    backdropObject = null;
                }
                return;
            }
            if (backdropObject != null) return;

            try
            {
                backdropObject = new GameObject("RecBlueLoginBackdrop");
                backdropObject.transform.SetParent(target.transform, false);
                Image layer = backdropObject.AddComponent<Image>();
                layer.sprite = backdropSprite;
                layer.type = Image.Type.Simple;
                layer.raycastTarget = false;
                RectTransform rect = backdropObject.GetComponent<RectTransform>();
                if (rect != null)
                {
                    rect.anchorMin = Vector2.zero;
                    rect.anchorMax = Vector2.one;
                    rect.offsetMin = Vector2.zero;
                    rect.offsetMax = Vector2.zero;
                }
                backdropObject.transform.SetAsFirstSibling();
                BrandingPlugin.Trace.LogInfo("fond : fond bleu pose sur le canvas du login");
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("fond : " + error.Message);
                backdropObject = null;
            }
        }

        // ------------------------------------------------------ fond bleu du login
        // Le fond du login est un grand aplat a motifs, dessine hors des canvas
        // classiques. On repeint la plus grande texture de la scene avec notre motif
        // bleu : tout ce qui la dessine change d'un coup, sans toucher a la mise en page.
        // La lecture de pixels (WarmRatio) levait une exception en IL2CPP et faisait
        // tout echouer en silence : on choisit donc sur la taille, pas sur la couleur.
        private bool backdropPainted;
        private bool backdropMissingLogged;
        private bool backdropListed;

        // Copie notre motif dans la texture cible, redimensionne a sa taille.
        private static bool CopyPixels(Texture2D source, Texture2D target)
        {
            RenderTexture buffer = null;
            RenderTexture previous = RenderTexture.active;
            try
            {
                buffer = RenderTexture.GetTemporary(target.width, target.height, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(source, buffer);
                RenderTexture.active = buffer;
                target.ReadPixels(new Rect(0f, 0f, target.width, target.height), 0, 0);
                target.Apply(false, false);
                return true;
            }
            catch { return false; }
            finally
            {
                RenderTexture.active = previous;
                if (buffer != null) RenderTexture.ReleaseTemporary(buffer);
            }
        }

        private void SwapLoginBackdrop()
        {
            if (backdropPainted) return;
            // Le fond du login n'est a l'ecran qu'au demarrage.
            if (Time.realtimeSinceStartup > 90f) return;
            try
            {
                if (!backdropLoadTried)
                {
                    backdropLoadTried = true;
                    Texture2D art = Load("RecLoginBackdrop.png");
                    if (art != null)
                    {
                        art.name = "RecLoginBackdrop";
                        backdropSprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                        backdropSprite.name = "RecLoginBackdropSprite";
                    }
                    else BrandingPlugin.Trace.LogWarning("fond : image absente du plugin");
                }
                if (backdropSprite == null) return;

                Texture2D best = null;
                int bestArea = 0;
                List<string> tops = new List<string>();
                foreach (Texture2D candidate in Resources.FindObjectsOfTypeAll<Texture2D>())
                {
                    if (candidate == null) continue;
                    int width;
                    int height;
                    try { width = candidate.width; height = candidate.height; } catch { continue; }
                    if (width < 512 || height < 256) continue;
                    string label;
                    try { label = candidate.name ?? ""; } catch { label = ""; }
                    if (label == "RecLoginBackdrop" || label.StartsWith("RecBlue", StringComparison.Ordinal)) continue;
                    int area = width * height;
                    if (tops.Count < 6) tops.Add(label + " " + width + "x" + height);
                    if (area <= bestArea) continue;
                    bestArea = area;
                    best = candidate;
                }
                if (!backdropListed && tops.Count > 0)
                {
                    backdropListed = true;
                    BrandingPlugin.Trace.LogInfo("fond : plus grandes textures " + string.Join(" ; ", tops.ToArray()));
                }
                if (best == null)
                {
                    if (!backdropMissingLogged)
                    {
                        backdropMissingLogged = true;
                        BrandingPlugin.Trace.LogInfo("fond : aucune grande texture trouvee");
                    }
                    return;
                }
                string chosen = best.name;
                int chosenWidth = best.width;
                int chosenHeight = best.height;
                if (!CopyPixels(backdropSprite.texture, best))
                {
                    BrandingPlugin.Trace.LogWarning("fond : copie impossible sur " + chosen);
                    return;
                }
                backdropPainted = true;
                BrandingPlugin.Trace.LogInfo("fond : texture " + chosen + " " + chosenWidth + "x" + chosenHeight + " repeinte en bleu");
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("fond : " + error.Message);
            }
        }

        private static float WarmRatio(Texture2D source)
        {
            RenderTexture target = null;
            RenderTexture previous = RenderTexture.active;
            Texture2D probe = null;
            float ratio = 0f;
            try
            {
                target = RenderTexture.GetTemporary(64, 64, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(source, target);
                RenderTexture.active = target;
                probe = new Texture2D(64, 64, TextureFormat.RGBA32, false);
                probe.ReadPixels(new Rect(0f, 0f, 64f, 64f), 0, 0);
                probe.Apply();
                Color32[] pixels = probe.GetPixels32();
                int warm = 0;
                for (int i = 0; i < pixels.Length; i++) if (IsWarmColour(pixels[i])) warm++;
                ratio = warm / (float)Mathf.Max(1, pixels.Length);
            }
            catch { }
            finally
            {
                RenderTexture.active = previous;
                if (target != null) RenderTexture.ReleaseTemporary(target);
                if (probe != null) Destroy(probe);
            }
            return ratio;
        }

        private void BackdropPass()
        {
            if (backdropDone) return;
            backdropDone = true;

            Texture2D art = Load("RecLoginBackdrop.png");
            if (art == null)
            {
                BrandingPlugin.Trace.LogWarning("fond : image absente du plugin");
                return;
            }
            art.hideFlags = HideFlags.DontUnloadUnusedAsset;

            Texture2D best = null;
            float bestScore = 0f;
            string leader = "?";
            List<string> tops = new List<string>();
            try
            {
                Texture2D[] all = Resources.FindObjectsOfTypeAll<Texture2D>();
                foreach (Texture2D candidate in all)
                {
                    if (candidate == null) continue;
                    int w = candidate.width;
                    int h = candidate.height;
                    if (w < 512 || h < 256 || w > 4096 || h > 4096) continue;
                    float ratio = WarmRatio(candidate);
                    if (ratio < 0.25f) continue;
                    if (tops.Count < 6) tops.Add(candidate.name + " " + w + "x" + h + " " + ratio.ToString("0.00"));
                    float score = ratio * (w * (float)h);
                    if (score <= bestScore) continue;
                    bestScore = score;
                    best = candidate;
                    leader = candidate.name;
                }
            }
            catch { }
            if (tops.Count > 0) BrandingPlugin.Trace.LogInfo("fond : candidats " + string.Join(" ; ", tops.ToArray()));
            if (best == null)
            {
                BrandingPlugin.Trace.LogInfo("fond : aucune texture orange de fond trouvee");
                return;
            }
            BrandingPlugin.Trace.LogInfo("fond : texture " + leader + " " + best.width + "x" + best.height + " remplacee");

            int images = 0;
            int raws = 0;
            int materials = 0;
            int spritesWorld = 0;

            try
            {
                Sprite artSprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                Image[] list = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in list)
                {
                    if (image == null) continue;
                    Sprite current;
                    try { current = image.sprite; } catch { continue; }
                    if (current == null) continue;
                    Texture2D texture;
                    try { texture = current.texture; } catch { continue; }
                    if (texture != best) continue;
                    try
                    {
                        image.sprite = artSprite;
                        image.type = Image.Type.Simple;
                        images++;
                    }
                    catch { }
                }
            }
            catch { }

            try
            {
                RawImage[] list = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in list)
                {
                    if (raw == null) continue;
                    Texture current;
                    try { current = raw.texture; } catch { continue; }
                    if (current != best) continue;
                    try { raw.texture = art; raws++; } catch { }
                }
            }
            catch { }

            try
            {
                SpriteRenderer[] list = Resources.FindObjectsOfTypeAll<SpriteRenderer>();
                foreach (SpriteRenderer renderer in list)
                {
                    if (renderer == null) continue;
                    Sprite current;
                    try { current = renderer.sprite; } catch { continue; }
                    if (current == null) continue;
                    Texture2D texture;
                    try { texture = current.texture; } catch { continue; }
                    if (texture != best) continue;
                    try
                    {
                        renderer.sprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                        spritesWorld++;
                    }
                    catch { }
                }
            }
            catch { }

            try
            {
                Renderer[] list = Resources.FindObjectsOfTypeAll<Renderer>();
                foreach (Renderer renderer in list)
                {
                    if (renderer == null) continue;
                    Material material;
                    try { material = renderer.sharedMaterial; } catch { continue; }
                    if (material == null) continue;
                    Texture current;
                    try { current = material.mainTexture; } catch { continue; }
                    if (current != best) continue;
                    try { material.mainTexture = art; materials++; } catch { }
                }
            }
            catch { }

            BrandingPlugin.Trace.LogInfo("fond : " + images + " image(s), " + raws + " rawimage(s), " + spritesWorld + " sprite(s) 3d, " + materials + " materiau(x) remplaces");
        }

        // Les libelles du jeu sont en TextMeshPro : on ne peut pas les reconnaître par
        // leur texte. On part donc de la structure : bouton JOUER (sprite Primary_Button)
        // puis la ligne suivant CHANGER DE COMPTE, et l'objet nomme LanguageSelection.
        private bool languageMoved2;
        private bool languageLogged;

        private static bool IsJouerSprite(string name)
        {
            return !string.IsNullOrEmpty(name) && name.IndexOf("Primary_Button", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static Transform FindNamed(string wanted)
        {
            Transform[] all = Resources.FindObjectsOfTypeAll<Transform>();
            foreach (Transform candidate in all)
            {
                if (candidate == null) continue;
                string name;
                try { name = candidate.name ?? ""; } catch { continue; }
                if (name == wanted) return candidate;
            }
            return null;
        }

        private static RectTransform Rect(Transform source)
        {
            try { return source.GetComponent<RectTransform>(); } catch { return null; }
        }

        private void MoveLanguageRow2()
        {
            if (languageMoved2) return;
            Transform jouerRow = null;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string spriteName;
                    try { spriteName = sprite.name ?? ""; } catch { continue; }
                    if (!IsJouerSprite(spriteName)) continue;
                    RectTransform rect = null;
                    try { rect = image.rectTransform; } catch { }
                    if (rect != null && rect.rect.width < 200f) continue;
                    jouerRow = Climb(image.transform);
                    if (jouerRow != null) break;
                }
            }
            catch { }
            if (jouerRow == null || jouerRow.parent == null)
            {
                return;
            }

            Transform parent = jouerRow.parent;
            Transform languageRow = FindNamed("LanguageSelection");
            if (languageRow == null)
            {
                if (!languageLogged)
                {
                    languageLogged = true;
                    string names = "";
                    for (int i = 0; i < parent.childCount && i < 12; i++)
                    {
                        Transform child = parent.GetChild(i);
                        string childName = "?";
                        try { childName = child != null ? child.name : "?"; } catch { }
                        names += childName + " | ";
                    }
                }
                return;
            }

            Transform language = Climb(languageRow);
            if (language == null || language.parent != parent)
            {
                if (!languageLogged) { languageLogged = true; BrandingPlugin.Trace.LogInfo("login : LanguageSelection hors du panneau"); }
                return;
            }

            try
            {
                int jouerIndex = jouerRow.GetSiblingIndex();
                Transform confirmRow = jouerIndex + 1 < parent.childCount ? parent.GetChild(jouerIndex + 1) : null;
                int wanted = confirmRow != null ? jouerIndex + 2 : jouerIndex + 1;
                language.SetSiblingIndex(Mathf.Min(wanted, parent.childCount - 1));

                RectTransform languageRect = Rect(language);
                RectTransform anchorRect = Rect(confirmRow != null ? confirmRow : jouerRow);
                if (languageRect != null && anchorRect != null)
                {
                    float y = anchorRect.anchoredPosition.y - anchorRect.rect.height * 0.5f - 14f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(anchorRect.anchoredPosition.x, y);
                }
                languageMoved2 = true;
                BrandingPlugin.Trace.LogInfo("login : langue deplacee sous CHANGER DE COMPTE");
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        // Version qui marche : on localise le bouton JOUER et la ligne LanguageSelection
        // par leurs composants Image, puis on remonte au plus proche ancetre commun et on
        // remet la langue apres CHANGER DE COMPTE (la ligne qui suit JOUER).
        private bool languageMoved3;
        private bool languageLogged3;

        // Diagnostic : liste les enfants du panneau de login et les menus deroulants charges,
        // pour savoir comment viser la ligne de langue.
        private void DescribeLoginPanel(Transform jouer)
        {
            try
            {
                int tmpro = 0;
                int uGui = 0;
                foreach (TMPro.TMP_Dropdown dropdown in Resources.FindObjectsOfTypeAll<TMPro.TMP_Dropdown>())
                    if (dropdown != null) tmpro++;
                foreach (Dropdown dropdown in Resources.FindObjectsOfTypeAll<Dropdown>())
                    if (dropdown != null) uGui++;
            }
            catch { }

            try
            {
                Transform titleTransform = null;
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { continue; }
                    if (name != "RecBlueTitle") continue;
                    titleTransform = image.transform;
                    break;
                }
                if (titleTransform == null || jouer == null)
                {
                    return;
                }
                Transform panel = Common(titleTransform, jouer);
                if (panel == null)
                {
                    return;
                }
                for (int i = 0; i < panel.childCount && i < 10; i++)
                {
                    Transform child = panel.GetChild(i);
                    if (child == null) continue;
                    RectTransform rect = Rect(child);
                    int height = rect != null ? Mathf.RoundToInt(rect.rect.height) : -1;
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("diag panneau : " + error.Message); }
        }

        // Version deterministe : on part de notre propre titre (sprite RecBlueTitle) pour
        // trouver le panneau du login, puis du bouton JOUER qui est dedans. La ligne de
        // langue est celle juste avant JOUER ; on la remet apres CHANGER DE COMPTE.
        private bool languageMoved4;
        private bool languageLogged4;

        private void MoveLanguageRow4()
        {
            if (languageMoved4) return;
            try
            {
                // Objets actifs seulement : la liste complete des images chargees coutait
                // plus de 100 ms et bloquait une frame a chaque tentative de placement.
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();

                // 1) notre titre, puis le panneau qui le contient
                Transform titleTransform = null;
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { continue; }
                    if (name != "RecBlueTitle") continue;
                    titleTransform = image.transform;
                    break;
                }
                if (titleTransform == null)
                {
                    return;
                }

                Transform panel = titleTransform;
                int guard = 0;
                while (panel != null && panel.parent != null && guard < 10)
                {
                    RectTransform rect = Rect(panel);
                    if (rect != null && rect.rect.height >= 400f && panel.childCount >= 4) break;
                    panel = panel.parent;
                    guard++;
                }
                if (panel == null || panel.parent == null) return;

                // 2) le bouton JOUER, cherche UNIQUEMENT dans ce panneau
                Transform jouerImage = null;
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    if (ChildUnder(panel, image.transform) == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { continue; }
                    if (!IsJouerSprite(name)) continue;
                    RectTransform rect = null;
                    try { rect = image.rectTransform; } catch { }
                    if (rect != null && rect.rect.width < 200f) continue;
                    jouerImage = image.transform;
                    break;
                }
                if (jouerImage == null)
                {
                    if (!languageLogged4)
                    {
                        languageLogged4 = true;
                        string names = "";
                        for (int i = 0; i < panel.childCount && i < 10; i++)
                        {
                            Transform child = panel.GetChild(i);
                            string childName = child != null ? child.name : "?";
                            names += childName + " | ";
                        }
                    }
                    return;
                }

                Transform jouerRow = ChildUnder(panel, jouerImage);
                if (jouerRow == null)
                {
                    if (!languageLogged4) { languageLogged4 = true; BrandingPlugin.Trace.LogInfo("login : bouton hors du panneau trouve"); }
                    return;
                }
                int jouerIndex = jouerRow.GetSiblingIndex();
                if (jouerIndex < 1)
                {
                    if (!languageLogged4) { languageLogged4 = true; BrandingPlugin.Trace.LogInfo("login : JOUER en position " + jouerIndex); }
                    return;
                }

                Transform languageRow = panel.GetChild(jouerIndex - 1);
                RectTransform languageRect = Rect(languageRow);
                if (languageRect == null) return;
                float width = languageRect.rect.width;
                float height = languageRect.rect.height;
                if (width < 450f || height > 170f)
                {
                    if (!languageLogged4)
                    {
                        languageLogged4 = true;
                        BrandingPlugin.Trace.LogInfo("login : ligne avant JOUER = " + languageRow.name + " " + Mathf.RoundToInt(width) + "x" + Mathf.RoundToInt(height) + " (non deplacee)");
                    }
                    return;
                }

                Transform confirmRow = jouerIndex + 1 < panel.childCount ? panel.GetChild(jouerIndex + 1) : jouerRow;
                int target = Mathf.Min(confirmRow.GetSiblingIndex() + 1, panel.childCount - 1);
                languageRow.SetSiblingIndex(target);

                RectTransform confirmRect = Rect(confirmRow);
                if (confirmRect != null)
                {
                    float y = confirmRect.anchoredPosition.y - confirmRect.rect.height * 0.5f - 14f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(confirmRect.anchoredPosition.x, y);
                }
                RectTransform panelRect = Rect(panel);
                if (panelRect != null) LayoutRebuilder.ForceRebuildLayoutImmediate(panelRect);

                languageMoved4 = true;
                BrandingPlugin.Trace.LogInfo("login : langue [" + languageRow.name + "] deplacee sous [" + confirmRow.name + "] dans " + panel.name);
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        private bool languageLoggedDropdown;

        private Transform LanguageFromDropdown()
        {
            try
            {
                TMPro.TMP_Dropdown[] dropdowns = Resources.FindObjectsOfTypeAll<TMPro.TMP_Dropdown>();
                foreach (TMPro.TMP_Dropdown dropdown in dropdowns)
                {
                    if (dropdown == null) continue;
                    bool active = false;
                    try { active = dropdown.gameObject != null && dropdown.gameObject.activeInHierarchy; } catch { }
                    if (!active) continue;
                    if (!languageLoggedDropdown)
                    {
                        languageLoggedDropdown = true;
                        BrandingPlugin.Trace.LogInfo("login : menu deroulant trouve (" + dropdown.gameObject.name + ")");
                    }
                    return dropdown.transform;
                }
            }
            catch { }
            return null;
        }

        private static bool HasAncestorNamed(Transform start, string wanted, int depth)
        {
            Transform current = start;
            for (int i = 0; i <= depth && current != null; i++)
            {
                string name;
                try { name = current.name ?? ""; } catch { name = ""; }
                if (name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                current = current.parent;
            }
            return false;
        }

        private static Transform ChildUnder(Transform ancestor, Transform item)
        {
            Transform current = item;
            while (current != null && current.parent != null && current.parent != ancestor) current = current.parent;
            return current != null && current.parent == ancestor ? current : null;
        }

        private static Transform Common(Transform a, Transform b)
        {
            HashSet<Transform> chain = new HashSet<Transform>();
            for (Transform t = a; t != null; t = t.parent) chain.Add(t);
            for (Transform t = b; t != null; t = t.parent) if (chain.Contains(t)) return t;
            return null;
        }

        private void MoveLanguageRow3()
        {
            if (languageMoved3) return;

            Transform jouer = null;
            // Une seule enumeration par passe : la faire dans la boucle des images mettait
            // le jeu a 0 fps (1500 enumerations d'objets par tentative).
            Transform language = LanguageFromDropdown();
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    if (jouer != null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string spriteName;
                    try { spriteName = sprite.name ?? ""; } catch { continue; }
                    if (!IsJouerSprite(spriteName)) continue;
                    RectTransform rect = null;
                    try { rect = image.rectTransform; } catch { }
                    if (rect != null && rect.rect.width < 200f) continue;
                    jouer = image.transform;
                }
            }
            catch { }

            if (jouer == null || language == null)
            {
                if (!languageLogged3)
                {
                    languageLogged3 = true;
                    BrandingPlugin.Trace.LogInfo("login : jouer=" + (jouer != null) + " langue=" + (language != null));
                    DescribeLoginPanel(jouer);
                }
                return;
            }

            try
            {
                Transform common = Common(jouer, language);
                if (common == null) return;
                Transform jouerChild = ChildUnder(common, jouer);
                Transform languageChild = ChildUnder(common, language);
                if (jouerChild == null || languageChild == null || jouerChild == languageChild)
                {
                    if (!languageLogged3) { languageLogged3 = true; BrandingPlugin.Trace.LogInfo("login : jouer et langue dans le meme bloc, rien a deplacer"); }
                    return;
                }

                int jouerIndex = jouerChild.GetSiblingIndex();
                Transform confirmChild = jouerIndex + 1 < common.childCount ? common.GetChild(jouerIndex + 1) : null;
                int wanted = confirmChild != null ? confirmChild.GetSiblingIndex() + 1 : jouerIndex + 1;
                languageChild.SetSiblingIndex(Mathf.Min(wanted, common.childCount - 1));

                RectTransform languageRect = Rect(languageChild);
                RectTransform anchorRect = Rect(confirmChild != null ? confirmChild : jouerChild);
                if (languageRect != null && anchorRect != null)
                {
                    float y = anchorRect.anchoredPosition.y - anchorRect.rect.height * 0.5f - 14f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(anchorRect.anchoredPosition.x, y);
                }

                RectTransform commonRect = Rect(common);
                if (commonRect != null) LayoutRebuilder.ForceRebuildLayoutImmediate(commonRect);

                languageMoved3 = true;
                BrandingPlugin.Trace.LogInfo("login : langue sous CHANGER DE COMPTE (" + common.name + " / " + languageChild.name + ")");
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        // ---------------------------------------------------------------- ordre du login
        // Le selecteur de langue doit passer SOUS le bouton CHANGER DE COMPTE. On remonte
        // depuis les deux libelles jusqu'au premier parent qui contient plusieurs elements
        // (le panneau), puis on remet la langue apres le bouton dans l'ordre des enfants.
        private bool languageMoved;

        private static Transform Climb(Transform start)
        {
            Transform current = start;
            int guard = 0;
            while (current != null && current.parent != null && current.parent.childCount <= 2 && guard < 12)
            {
                current = current.parent;
                guard++;
            }
            return current;
        }

        private void MoveLanguageRow()
        {
            if (languageMoved) return;
            Transform confirm = null;
            Transform language = null;
            try
            {
                Text[] texts = Resources.FindObjectsOfTypeAll<Text>();
                foreach (Text text in texts)
                {
                    if (text == null) continue;
                    string label;
                    try { label = text.text ?? ""; } catch { continue; }
                    if (label.Length == 0) continue;
                    if (confirm == null && label.IndexOf("CHANGER DE COMPTE", StringComparison.OrdinalIgnoreCase) >= 0) confirm = text.transform;
                    if (language == null && (label.IndexOf("Francais", StringComparison.OrdinalIgnoreCase) >= 0 || label.IndexOf("Fran\u00e7ais", StringComparison.OrdinalIgnoreCase) >= 0)) language = text.transform;
                }
            }
            catch { }
            if (confirm == null || language == null) return;

            Transform confirmRow = Climb(confirm);
            Transform languageRow = Climb(language);
            if (confirmRow == null || languageRow == null) return;
            if (confirmRow.parent == null || languageRow.parent == null) return;
            if (confirmRow.parent != languageRow.parent) return;

            try
            {
                languageRow.SetSiblingIndex(confirmRow.GetSiblingIndex() + 1);
                RectTransform confirmRect = confirmRow.GetComponent<RectTransform>();
                RectTransform languageRect = languageRow.GetComponent<RectTransform>();
                if (confirmRect != null && languageRect != null)
                {
                    float y = confirmRect.anchoredPosition.y - confirmRect.rect.height * 0.5f - 12f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(confirmRect.anchoredPosition.x, y);
                }
                languageMoved = true;
                BrandingPlugin.Trace.LogInfo("login : selecteur de langue place sous CHANGER DE COMPTE");
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        // Diagnostic : liste les grands elements d'image de l'ecran courant (nom du sprite,
        // de la texture, chemin d'objets) pour retrouver le logo du login et du chargement.
        // Ne s'execute que si RECBLUE_DUMP_LOGOS.txt existe dans plugins.
        private bool logoScreenDumped;
        private float nextLogoDumpAt;
        private int logoDumpPass;

        private void DumpLogoOnce(float now)
        {
            if (logoScreenDumped) return;
            try { if (!System.IO.File.Exists("C:/RecRoom2023/BepInEx/plugins/RECBLUE_DUMP_LOGOS.txt")) return; } catch { return; }
            if (now < nextLogoDumpAt) return;
            nextLogoDumpAt = now + 5f;
            if (logoDumpPass >= 12) { logoScreenDumped = true; return; }
            logoDumpPass++;
            BrandingPlugin.Trace.LogInfo("diag logo : --- passe " + logoDumpPass + " (" + Mathf.RoundToInt(now - startedAt) + " s)");
            try
            {
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();
                int shown = 0;
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Rect rect;
                    try { rect = image.rectTransform.rect; } catch { continue; }
                    string path = PathOf(image.transform, 5);
                    string lower = path.ToLowerInvariant();
                    bool boot = lower.Contains("bootui") || lower.Contains("title loading screen");
                    if (!boot && (rect.width < 150f || rect.height < 60f)) continue;
                    Sprite sprite = null;
                    try { sprite = image.sprite; } catch { }
                    string spriteName = "aucun";
                    string textureName = "aucune";
                    if (sprite != null)
                    {
                        try { spriteName = sprite.name ?? "?"; } catch { }
                        try { textureName = sprite.texture != null ? (sprite.texture.name ?? "?") : "?"; } catch { }
                    }
                    BrandingPlugin.Trace.LogInfo("diag logo : " + Mathf.RoundToInt(rect.width) + "x" + Mathf.RoundToInt(rect.height) + " sprite=" + spriteName + " tex=" + textureName + " chemin=" + path);
                    if (++shown >= 25) break;
                }
            }
            catch { }
            try
            {
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                int shownRaw = 0;
                foreach (RawImage raw in raws)
                {
                    if (raw == null) continue;
                    Rect rect;
                    try { rect = raw.rectTransform.rect; } catch { continue; }
                    if (rect.width < 150f || rect.height < 60f) continue;
                    string tex = "aucune";
                    try { tex = raw.texture != null ? (raw.texture.name ?? "?") : "aucune"; } catch { }
                    string path = "";
                    try
                    {
                        Transform t = raw.transform;
                        int guard = 0;
                        while (t != null && guard++ < 4) { path = t.name + "/" + path; t = t.parent; }
                    }
                    catch { }
                    BrandingPlugin.Trace.LogInfo("diag logo : " + Mathf.RoundToInt(rect.width) + "x" + Mathf.RoundToInt(rect.height) + " raw tex=" + tex + " chemin=" + path);
                    if (++shownRaw >= 10) break;
                }
            }
            catch { }
        }

        // Une passe de logo est decoupee : la liste est gardee entre les frames et
        // parcourue par tranches de 0,30 ms. La passe complete coutait 170 ms d'un coup,
        // ce qui se voyait comme un gel a chaque nouvelle image du jeu.
        private Image[] sweepQueue;
        private int sweepCursor;
        private readonly List<Image> logoCanaries = new List<Image>();
        private int lastLoggedSwapped = -1;
        private int sweepSwapped;
        private bool sweepDeep;
        private float sweepStartedAt;

        private void Sweep()
        {
            if (safeMode) return;
            if (titleSprite == null) return;
            frameSweep = true;
            try
            {
                if (sweepQueue == null)
                {
                    // Passe profonde tant que le logo n'est pas pose : les gabarits inactifs
                    // portent le sprite d'origine, et il quitte la scene des que l'ecran de
                    // chargement est passe. Ensuite uniquement les objets actifs.
                    bool deep = !titleSwapped;
                    System.Diagnostics.Stopwatch scan = System.Diagnostics.Stopwatch.StartNew();
                    try
                    {
                        sweepQueue = deep
                            ? Resources.FindObjectsOfTypeAll<Image>()
                            : UnityEngine.Object.FindObjectsOfType<Image>();
                    }
                    catch { sweepQueue = new Image[0]; }
                    sweepCursor = 0;
                    sweepSwapped = 0;
                    sweepDeep = deep;
                    sweepStartedAt = Time.realtimeSinceStartup;
                    if (scan.ElapsedMilliseconds >= 20)
                        BrandingPlugin.Trace.LogInfo("perf : sweep " + scan.ElapsedMilliseconds + " ms, " + sweepQueue.Length + " image(s)" + (deep ? " (profonde)" : ""));
                }
                System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
                while (sweepCursor < sweepQueue.Length)
                {
                    Image image = sweepQueue[sweepCursor++];
                    if (image != null)
                    {
                        Sprite current = null;
                        try { current = image.sprite; } catch { }
                        string name = "";
                        if (current != null)
                        {
                            try { name = current.name ?? ""; } catch { name = ""; }
                        }
                        bool brand = IsBrandSprite(name);
                        if (!brand)
                        {
                            // Le logo du login et celui du chargement ne portent pas toujours un
                            // sprite au nom attendu : sur une image assez grande pour etre un
                            // logo, on regarde aussi le nom des objets au-dessus d'elle.
                            Rect box = default(Rect);
                            try { box = image.rectTransform.rect; } catch { }
                            if (box.width >= 300f && box.height >= 120f)
                                brand = IsBrandPath(PathOf(image.transform, 5));
                        }
                        if (brand)
                        {
                            try
                            {
                                image.sprite = titleSprite;
                                // Le cadre d'origine etait prevu pour un logo large : sans ca
                                // notre image est estiree et deborde de son emplacement.
                                image.preserveAspect = true;
                                sweepSwapped++;
                                if (logoCanaries.Count < 40 && !logoCanaries.Contains(image)) logoCanaries.Add(image);
                                // Pas d'agrandissement : x1.8 puis x1.25 ont tous deux ete
                                // juges trop gros et masquaient le panneau. On garde le cadre
                                // d'origine du jeu.
                            }
                            catch { }
                        }
                    }
                    // La passe profonde arrive pendant le chargement : elle doit finir tant que
                    // l'ecran de chargement est la, sinon le logo disparait avant d'etre vu.
                    // Les passes suivantes, repetees, restent bornees a 0,30 ms par frame.
                    if (!sweepDeep && watch.Elapsed.TotalMilliseconds >= 0.30) return;
                }
                if (sweepDeep)
                {
                    int spent = Mathf.RoundToInt((Time.realtimeSinceStartup - sweepStartedAt) * 1000f);
                    if (spent >= 50)
                        BrandingPlugin.Trace.LogInfo("perf : sweep profonde " + spent + " ms (" + sweepQueue.Length + " images)");
                }
                if (sweepSwapped > 0)
                {
                    titleSwapped = true;
                    // Le jeu reconstruit son logo en boucle au demarrage : on ne journalise
                    // qu'au changement de compte pour ne pas noyer le log.
                    if (sweepSwapped != lastLoggedSwapped)
                    {
                        lastLoggedSwapped = sweepSwapped;
                        BrandingPlugin.Trace.LogInfo("marque : " + sweepSwapped + " sprite(s) remplace(s) a " + Mathf.RoundToInt(Time.realtimeSinceStartup) + " s.");
                    }
                }
                // Certains logos passent par une RawImage (texture et non sprite) : on leur
                // substitue la planche du titre pour ne pas laisser un logo orange.
                try
                {
                    RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                    int rawsDone = 0;
                    foreach (RawImage raw in raws)
                    {
                        if (raw == null) continue;
                        Rect box = default(Rect);
                        try { box = raw.rectTransform.rect; } catch { }
                        if (box.width < 300f || box.height < 120f) continue;
                        if (!IsBrandPath(PathOf(raw.transform, 5))) continue;
                        try { raw.texture = title; rawsDone++; } catch { }
                    }
                    if (rawsDone > 0)
                        BrandingPlugin.Trace.LogInfo("marque : " + rawsDone + " texture(s) de logo remplacee(s).");
                }
                catch { }
                sweepQueue = null;
            }
            catch { sweepQueue = null; }
        }

        // Chemin des objets au-dessus d'un element, borne en profondeur : sert a
        // reconnaitre les logos dont le sprite n'a pas un nom parlant.
        private static string PathOf(Transform start, int depth)
        {
            string path = "";
            try
            {
                Transform t = start;
                int guard = 0;
                while (t != null && guard++ < depth)
                {
                    string n = t.name ?? "?";
                    path = n + "/" + path;
                    t = t.parent;
                }
            }
            catch { }
            return path;
        }

        private static bool IsBrandPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string p = path.ToLowerInvariant();
            return p.Contains("rec room logo")
                || p.Contains("recroomlogo")
                || p.Contains("image - change icon here");
        }

        private static bool IsBrandSprite(string name)
        {
            if (string.IsNullOrEmpty(name) || name == "RecBlueTitle") return false;
            foreach (string target in LogoSprites)
                if (name.StartsWith(target, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private void Update()
        {
            try
            {
                // Sonde : chaque gel de frame est signale avec le travail du plugin qui l'a
                // precedee. Plafonnee a 40 lignes pour ne pas noyer le journal.

                if (!perfApplied)
                {
                    perfApplied = true;
                    ApplyPerf();
                }
                if (!quietReported && Time.timeSinceLevelLoad > 45f)
                {
                    quietReported = true;
                    BrandingPlugin.Trace.LogInfo("console : " + QuietConsole.Hidden + " ligne(s) reseau masquee(s).");
                }
                if (!safeChecked)
                {
                    safeChecked = true;
                    try { safeMode = System.IO.File.Exists(SafeMarker); } catch { }
                    if (safeMode)
                        BrandingPlugin.Trace.LogInfo("mode sans branding : titre, couleurs et textures laisses au jeu (configuration fps conservee).");
                }
                ReadMode();
                if (!safeMode) Prepare();

                // Diagnostic A/B : si le marqueur existe, les passes s'arretent apres 45 s
                // mais la sonde de fps continue. On mesure ainsi le cout reel du plugin
                // dans la meme piece, au lieu de comparer deux ecrans differents.
                if (!idleFlagRead)
                {
                    idleFlagRead = true;
                    try { idleForced = System.IO.File.Exists("C:/RecRoom2023/BepInEx/plugins/RECBLUE_IDLE.txt"); } catch { }
                }
                if (idleForced && Time.realtimeSinceStartup - startedAt > 45f)
                {
                    if (!idleLogged)
                    {
                        idleLogged = true;
                    }
                    return;
                }

                float now = Time.realtimeSinceStartup;
                if (startedAt <= 0f) startedAt = now;
                float age = now - startedAt;

                // Le jeu reconstruit son theme des qu'on clique : sans ce reveil l'orange
                // revenait jusqu'a la passe de securite (30 s plus tard).
                ApplyPerf();
                CheckCanaries(now);
                QualityGuard.Enforce(BrandingPlugin.Trace, now);
                CheckSelection();
                if (age < 8f) RequestPaint(2f);
                PaintSlice();
                DumpLogoOnce(now);


                if (!sceneHooked)
                {
                    // Pas d'abonnement a sceneLoaded : UnityAction n'est pas un delegue dans
                    // l'interop Il2Cpp. La variation du nombre de Canvas joue ce role et
                    // couvre aussi les panneaux qui s'ouvrent sans changer de scene.
                    sceneHooked = true;
                }

                // Sweep/TintPass enumerent tous les Graphic et Selectable vivants : couteux.
                // Tourner en boucle faisait saccader le jeu ; ne tourner qu'au demarrage
                // faisait perdre le bleu des ecrans tardifs. On tourne donc par salves.
                if (now >= nextCanvasCheck)
                {
                    nextCanvasCheck = now + 5f;
                    int canvases = 0;
                    try { canvases = FindObjectsOfType<Canvas>().Length; } catch { }
                    if (canvases != canvasSeen)
                    {
                        int jump = canvases - canvasSeen;
                        canvasSeen = canvases;
                        burstUntil = now + 8f;
                        // Nouveau panneau : on repeint tout de suite ses textes.
                        RequestPaint(4f);
                        // Nouvel ecran : on relance la passe de logo sans attendre le balayage
                        // suivant (20 s), sinon le logo du jeu reste visible tout ce temps.
                        if (now - lastSweepAt >= 0.3f) nextSweep = now;
                        // On ne repousse plus la passe : chaque canvas qui apparait la repoussait
                        // de 1,5 s et le balayage n'etait jamais execute (titre jamais pose).
                        // Le plancher de 8 s entre deux passes suffit a eviter les rafales.
                        // On laisse le panneau finir de s'ouvrir avant de l'enumerer : sinon
                        // la sonde mesure 568 ms de gel pendant son animation.
                        nextEnqueue = now + 1.5f;
                    }
                }

                bool bursting = now < burstUntil && age < BrandWindow;
                // Le titre doit revenir meme si le logo n'apparait qu'apres la fenetre de 20 s
                // (constate sur le tableau : "titre REC BLUE introuvable"). Une fois les
                // premiers remplacements faits, la verification s'espace pour ne rien couter.
                // Une passe de logo commencee se poursuit a chaque frame, par tranches.
                if (sweepQueue != null) Sweep();

                // Au demarrage, un nouvel ecran doit etre traite tout de suite : le logo du
                // jeu ne doit pas rester affiche. Le plancher de 8 s ne revient qu'ensuite.
                float sweepFloor = age < 60f ? 0.4f : 8f;
                if (now >= nextSweep && now - lastSweepAt >= sweepFloor)
                {
                    System.Diagnostics.Stopwatch blockWatch = System.Diagnostics.Stopwatch.StartNew();
                    // Une passe enumere toutes les Image vivantes : six passes au demarrage ont
                    // ete mesurees a 2,3 s de gel. Minimum 8 s entre deux, puis 120 s.
                    lastSweepAt = now;
                    // Tant que le titre n'est pas pose on retente toutes les 20 s (le logo
                    // n'existe pas encore pendant le chargement) ; ensuite 120 s suffisent.
                    nextSweep = now + (age < 60f ? 0.5f : (sweeps > 9 ? 120f : 20f));
                    sweeps++;
                    Sweep();
                    // Nouvel ecran vu : on repeint ses textes et son tableau tout de suite.
                    RequestPaint(3f);
                    // Couche bleue desactivee : posee dans le mauvais canvas, elle passait
                    // devant le panneau et masquait tout l'ecran de login.
                    if (backdropObject != null)
                    {
                        try { Destroy(backdropObject); } catch { }
                        backdropObject = null;
                    }
                    if (loginAttempts < 5)
                    {
                        loginAttempts++;
                        MoveLanguageRow4();
                    }
                    // La palette RRUI est la source du bleu, mais sa conversion passe en
                    // reflection sur tous les assets : lancee a chaque salve (0,5 s apres un
                    // clic) elle provoquait les gels. Une fois toutes les 10 s suffit.
                    if (!safeMode && paintTextures && now >= nextPaletteAt && Time.unscaledDeltaTime < 0.04f)
                    {
                        nextPaletteAt = now + 60f;
                        palettePasses++;
                        try { PalettePass(); } catch { }
                    }
                    if (blockWatch.ElapsedMilliseconds >= 40)
                        BrandingPlugin.Trace.LogInfo("perf : bloc balayage " + blockWatch.ElapsedMilliseconds + " ms");
                }

                // La sonde mesure 568 ms pour une enumeration complete des Image : elle n'est
                // plus faite toutes les 2 s mais a l'ouverture d'un panneau (salve) et deux
                // fois au demarrage. Les textures deja converties restent en cache.
                if (!safeMode && paintTextures && age > StartDelay && now >= nextEnqueue && (bursting || enqueueRuns < 2))
                {
                    enqueueRuns++;
                    nextEnqueue = now + (bursting ? 10f : 30f);
                    Enqueue();
                }

                if (paintTextures)
                {
                    int before = texturesDone;
                    ProcessQueue();
                    if (texturesDone != before) nextRebind = now + 6.0f;
                }

                if (nextRebind > 0f && now >= nextRebind && queue.Count == 0)
                {
                    nextRebind = 0f;
                    RebindSprites();
                }

                if (now - startedAt > Window && queue.Count == 0 && !rebound)
                {
                    rebound = true;
                    RebindSprites();
                    BrandingPlugin.Trace.LogInfo("surveillance : veille active (salve a chaque changement d'ecran, passe de securite toutes les 30 s).");
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogError(error); }
        }
    }
}
