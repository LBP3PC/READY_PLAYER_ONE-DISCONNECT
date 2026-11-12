using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using HarmonyLib;
using UnityEngine;

namespace RecNetPlugin.Patches;

// Diagnostic only. Two jobs:
//   1. Show where the stored device id lives, by logging PlayerPrefs reads/writes.
//   2. Show how far the DUID migration branch gets, by logging CheatManager's other DUID methods.
//      If WriteDUIDs() never fires after the deviceId POST, the flow stalls before it.
//
// Privacy: the probe sees every PlayerPrefs read, so the raw values include auth tokens, session
// ids and account secrets. Values that look sensitive are never written verbatim: they are
// replaced by a fingerprint (length + short SHA-256 prefix), which still lets two occurrences be
// compared across logs without revealing the secret.
[HarmonyPatch]
public static class DUIDProbePatch
{
    // PlayerPrefs.GetString is called constantly, so log each key only once — except device/DUID
    // keys, which we always log so we can watch them change across the migration.
    private static readonly HashSet<string> SeenKeys = new();

    // If the key mentions any of these, its value is treated as a secret.
    private static readonly string[] SensitiveHints =
    {
        "token", "password", "passwd", "pwd", "auth", "session", "secret", "credential",
        "sid", "jwt", "refresh", "access", "key", "duid", "device", "anon", "email",
        "login", "pun", "cached", "recent_players",
    };

    // Anything longer than this is treated as a secret whatever its key: tokens, cached server
    // responses and telemetry blobs all live in this size range, and none belong in a log.
    private const int MaxClearLength = 24;

    // A long unbroken run of token-ish characters is a secret even when the key name says nothing.
    private static readonly Regex SecretShaped = new("^[A-Za-z0-9+/=_\\-\\.]{24,}$", RegexOptions.Compiled);

    // Server addresses stay out of the log as well.
    private static readonly Regex IpShaped = new("\\b\\d{1,3}(\\.\\d{1,3}){3}\\b", RegexOptions.Compiled);

    private static bool IsInteresting(string key) =>
        key != null && (key.Contains("DUID") || key.Contains("Duid") || key.Contains("duid")
                     || key.Contains("Device") || key.Contains("device")
                     || key.Contains("Anon") || key.Contains("anon"));

    private static bool IsSensitive(string key)
    {
        if (string.IsNullOrEmpty(key)) return false;
        foreach (var hint in SensitiveHints)
            if (key.IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }

    /// <summary>
    /// Value as it may appear in the log: verbatim when harmless, otherwise a fingerprint.
    /// </summary>
    public static string Safe(string key, string value)
    {
        if (string.IsNullOrEmpty(value)) return value ?? string.Empty;
        var secret = IsSensitive(key)
                     || value.Length > MaxClearLength
                     || SecretShaped.IsMatch(value)
                     || IpShaped.IsMatch(value);
        return secret ? Fingerprint(value) : value;
    }

    /// <summary>Short stable digest: lets a reader match two values without seeing either.</summary>
    public static string Fingerprint(string value)
    {
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
        var sb = new StringBuilder(8);
        for (var i = 0; i < 4; i++) sb.Append(hash[i].ToString("x2"));
        return $"<masque {value.Length} car., empreinte {sb}>";
    }

    private static void Note(string op, string key, string value)
    {
        var shown = Safe(key, value);
        if (IsInteresting(key))
            Plugin.Log.LogWarning($"[DUID-PROBE] {op} {key} = \"{shown}\"");
        else if (SeenKeys.Add($"{op}:{key}"))
            Plugin.Log.LogInfo($"[DUID-PROBE] {op} {key} = \"{shown}\"");
    }

    [HarmonyPostfix]
    [HarmonyPatch(typeof(PlayerPrefs), nameof(PlayerPrefs.GetString), [typeof(string)])]
    private static void GetStringPostfix(string key, string __result) => Note("get", key, __result);

    [HarmonyPostfix]
    [HarmonyPatch(typeof(PlayerPrefs), nameof(PlayerPrefs.GetString), [typeof(string), typeof(string)])]
    private static void GetStringDefaultPostfix(string key, string __result) => Note("get", key, __result);

    [HarmonyPrefix]
    [HarmonyPatch(typeof(PlayerPrefs), nameof(PlayerPrefs.SetString))]
    private static void SetStringPrefix(string key, string value) => Note("SET", key, value);

    [HarmonyPrefix]
    [HarmonyPatch(typeof(PlayerPrefs), nameof(PlayerPrefs.DeleteKey))]
    private static void DeleteKeyPrefix(string key) => Note("DEL", key, "<deleted>");

    [HarmonyPrefix]
    [HarmonyPatch(typeof(CheatManager), "WriteDUIDs")]
    private static void WriteDUIDsPrefix() => Plugin.Log.LogWarning("[DUID-PROBE] WriteDUIDs() called");

    [HarmonyPostfix]
    [HarmonyPatch(typeof(CheatManager), "WriteDUIDs")]
    private static void WriteDUIDsPostfix() => Plugin.Log.LogWarning("[DUID-PROBE] WriteDUIDs() returned");

    [HarmonyPrefix]
    [HarmonyPatch(typeof(CheatManager), "ClearDUIDs")]
    private static void ClearDUIDsPrefix() => Plugin.Log.LogWarning("[DUID-PROBE] ClearDUIDs() called");
}
