using System;
using System.Collections.Generic;
using System.IO;
using AssetsTools.NET.Extra;

internal static class Program
{
    // Couleurs orange relevees dans le theme RRUI et leur equivalent bleu REC BLUE.
    private static readonly float[][] Orange =
    {
        new[] { 0.945f, 0.353f, 0.145f },
        new[] { 0.840f, 0.254f, 0.000f },
        new[] { 0.878f, 0.424f, 0.129f },
        new[] { 0.702f, 0.212f, 0.000f },
        new[] { 0.820f, 0.275f, 0.039f },
        new[] { 0.726f, 0.169f, 0.154f },
        new[] { 0.992f, 0.510f, 0.302f },
        new[] { 0.859f, 0.224f, 0.024f },
        new[] { 0.830f, 0.329f, 0.153f },
        new[] { 0.878f, 0.616f, 0.129f }
    };

    private static readonly float[][] Blue =
    {
        new[] { 0.011f, 0.306f, 0.964f },
        new[] { 0.000f, 0.265f, 0.856f },
        new[] { 0.004f, 0.281f, 0.896f },
        new[] { 0.000f, 0.222f, 0.716f },
        new[] { 0.000f, 0.259f, 0.836f },
        new[] { 0.054f, 0.267f, 0.741f },
        new[] { 0.170f, 0.427f, 1.000f },
        new[] { 0.000f, 0.272f, 0.876f },
        new[] { 0.037f, 0.288f, 0.847f },
        new[] { 0.004f, 0.281f, 0.896f }
    };

    private static void WriteFloat(byte[] data, long offset, float value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        data[offset] = bytes[0];
        data[offset + 1] = bytes[1];
        data[offset + 2] = bytes[2];
        data[offset + 3] = bytes[3];
    }

    private static int Main(string[] args)
    {
        string path = @"C:\RecRoom2023\RecRoom_Data\resources.assets";
        bool apply = Array.IndexOf(args, "--apply") >= 0;
        foreach (string arg in args)
            if (arg.StartsWith("--file=")) path = arg.Substring("--file=".Length);

        if (!File.Exists(path)) { Console.WriteLine("fichier absent : " + path); return 2; }
        byte[] data = File.ReadAllBytes(path);
        Console.WriteLine("fichier " + path + " (" + data.Length + " octets)");

        var objects = new List<(long offset, long length, long id)>();
        try
        {
            AssetsManager manager = new AssetsManager();
            AssetsFileInstance instance = manager.LoadAssetsFile(path, false);
            foreach (var info in instance.file.AssetInfos)
            {
                Type type = info.GetType();
                object offsetValue = type.GetProperty("ByteOffset")?.GetValue(info);
                object sizeValue = type.GetProperty("ByteSize")?.GetValue(info);
                if (offsetValue == null || sizeValue == null) continue;
                int typeId = 0;
                try { typeId = Convert.ToInt32(type.GetProperty("TypeId")?.GetValue(info) ?? 0); } catch { }
                if (typeId != 114) continue; // MonoBehaviour : prefabs, styles, palettes
                long offset = Convert.ToInt64(offsetValue);
                long length = Convert.ToInt64(sizeValue);
                if (length < 200) continue;
                long id = Convert.ToInt64(type.GetProperty("PathId")?.GetValue(info) ?? -1L);
                objects.Add((offset, length, id));
            }
        }
        catch (Exception error) { Console.WriteLine("AssetsTools : " + error.Message); return 4; }

        Console.WriteLine("MonoBehaviours inspectes : " + objects.Count);

        int totalHits = 0, touchedObjects = 0;
        var perColour = new int[Orange.Length];
        foreach (var obj in objects)
        {
            long end = obj.offset + obj.length;
            int hits = 0;
            for (long i = obj.offset; i + 12 <= end; i += 4)
            {
                float r = BitConverter.ToSingle(data, (int)i);
                int match = -1;
                for (int t = 0; t < Orange.Length; t++)
                {
                    if (Math.Abs(r - Orange[t][0]) > 0.0015f) continue;
                    if (Math.Abs(BitConverter.ToSingle(data, (int)(i + 4)) - Orange[t][1]) > 0.0015f) continue;
                    if (Math.Abs(BitConverter.ToSingle(data, (int)(i + 8)) - Orange[t][2]) > 0.0015f) continue;
                    match = t;
                    break;
                }
                if (match < 0) continue;

                if (hits < 3)
                    Console.WriteLine("  objet " + obj.id + " offset " + i + " : orange #" + match
                        + " -> bleu (" + Blue[match][0] + ", " + Blue[match][1] + ", " + Blue[match][2] + ")");
                if (apply)
                {
                    WriteFloat(data, i, Blue[match][0]);
                    WriteFloat(data, i + 4, Blue[match][1]);
                    WriteFloat(data, i + 8, Blue[match][2]);
                }
                perColour[match]++;
                hits++;
                totalHits++;
            }
            if (hits > 0) touchedObjects++;
        }

        for (int t = 0; t < Orange.Length; t++)
            Console.WriteLine("  couleur #" + t + " : " + perColour[t] + " remplacement(s)");
        Console.WriteLine("total : " + totalHits + " remplacement(s) dans " + touchedObjects + " objet(s)");

        if (!apply)
        {
            Console.WriteLine("mode lecture seule : rien n'a ete ecrit (ajouter --apply)");
            return 0;
        }
        if (totalHits == 0) { Console.WriteLine("aucune modification"); return 0; }

        string backup = path + ".recblue-backup";
        if (!File.Exists(backup)) { Console.WriteLine("sauvegarde manquante, ecriture annulee"); return 3; }
        File.WriteAllBytes(path, data);
        Console.WriteLine("ecrit dans " + path);
        return 0;
    }
}
