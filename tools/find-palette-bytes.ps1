# Reconnaissance (lecture seule) : ou vivent Palette_LightTheme et ses couleurs orange
# dans RecRoom_Data/resources.assets. N'ecrit rien.
$ErrorActionPreference = 'Stop'
$path = 'C:\RecRoom2023\RecRoom_Data\resources.assets'

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;

public static class PaletteScanner
{
    public static string Scan(string path)
    {
        byte[] data = File.ReadAllBytes(path);
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("taille=" + data.Length);

        byte[] name = Encoding.ASCII.GetBytes("Palette_LightTheme");
        int found = 0;
        for (int i = 0; i <= data.Length - name.Length; i++)
        {
            if (data[i] != name[0]) continue;
            bool ok = true;
            for (int j = 1; j < name.Length; j++) { if (data[i + j] != name[j]) { ok = false; break; } }
            if (!ok) continue;
            if (found < 10) sb.AppendLine("nom a l'offset " + i);
            found++;
        }
        sb.AppendLine("occurrences du nom : " + found);

        float[][] targets = new float[][]
        {
            new float[] { 0.945f, 0.353f, 0.145f },
            new float[] { 0.840f, 0.254f, 0.000f },
            new float[] { 0.878f, 0.424f, 0.129f },
            new float[] { 0.702f, 0.212f, 0.000f },
            new float[] { 0.820f, 0.275f, 0.039f }
        };

        int[] counts = new int[targets.Length];
        for (int t = 0; t < targets.Length; t++)
        {
            float r = targets[t][0], g = targets[t][1], b = targets[t][2];
            int hits = 0;
            for (int i = 0; i <= data.Length - 12; i += 4)
            {
                float pr = BitConverter.ToSingle(data, i);
                if (Math.Abs(pr - r) > 0.002f) continue;
                float pg = BitConverter.ToSingle(data, i + 4);
                if (Math.Abs(pg - g) > 0.002f) continue;
                float pb = BitConverter.ToSingle(data, i + 8);
                if (Math.Abs(pb - b) > 0.002f) continue;
                float pa = BitConverter.ToSingle(data, i + 12);
                if (Math.Abs(pa - 1f) > 0.01f) continue;
                if (hits < 12) sb.AppendLine("couleur " + t + " offset " + i);
                hits++;
            }
            counts[t] = hits;
            sb.AppendLine("couleur " + t + " : " + hits + " occurrence(s)");
        }
        return sb.ToString();
    }
}
"@

[PaletteScanner]::Scan($path)
