using System;
using HarmonyLib;

namespace RecNetPlugin.Patches;

/**
    Drops the localisation warning the 2023 client repeats while it runs:

        Could not find an entry with key `EMOTES` in table TableReference(… - Player.Interaction)

    The literal is `"Could not find an entry with key `{0}` in table {1}"` in the game's
    il2cpp metadata, so the line is emitted by native code and the server cannot fix it: the
    only server-side lever is the strings document, and this client stalls its boot when it
    gets one it does not parse (measured twice, 2026-11-11 and 2026-11-12).

    HarmonyX binds by exact parameter type, and Il2CppInterop rewrites `object` to
    `Il2CppSystem.Object` — binding with System.Object is what made the first attempt fail
    with "Could not find method for type UnityEngine.Debug and name LogWarning".
*/
[HarmonyPatch]
public static class LocalizationNoisePatch
{
    private const string Needle = "Could not find an entry with key";

    private static int _dropped;

    private static bool Drop(string text)
    {
        if (text == null || text.IndexOf(Needle, System.StringComparison.Ordinal) < 0) return false;

        _dropped++;
        // First drop, then every hundred: enough to prove the filter is alive without
        // rebuilding the noise it exists to remove.
        if (_dropped == 1 || _dropped % 100 == 0)
            Plugin.Log.LogInfo($"[LOCALISATION] avertissement de cle manquante filtre ({_dropped})");
        return true;
    }

    [HarmonyPrefix]
    [HarmonyPatch(typeof(UnityEngine.Debug), nameof(UnityEngine.Debug.LogWarning), [typeof(Il2CppSystem.Object)])]
    private static bool PrefixWarning(Il2CppSystem.Object __0) => !Drop(__0?.ToString());

    [HarmonyPrefix]
    [HarmonyPatch(typeof(UnityEngine.Debug), nameof(UnityEngine.Debug.LogWarning), [typeof(Il2CppSystem.Object), typeof(UnityEngine.Object)])]
    private static bool PrefixWarningWithContext(Il2CppSystem.Object __0, UnityEngine.Object __1) => !Drop(__0?.ToString());

    // The message carries two placeholders, so a formatter is as likely as the plain call.
    [HarmonyPrefix]
    [HarmonyPatch(typeof(UnityEngine.Debug), nameof(UnityEngine.Debug.LogWarningFormat), [typeof(string), typeof(Il2CppSystem.Object[])])]
    private static bool PrefixWarningFormat(string __0, Il2CppSystem.Object[] __1) => !Drop(__0);
}
