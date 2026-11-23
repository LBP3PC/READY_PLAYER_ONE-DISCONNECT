import json
import subprocess

W = r'C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809'
node = W + r'\.tools\node-v22.23.4-win-x64\node.exe'
wr = W + r'\recflare-serveur\node_modules\.pnpm\wrangler@4.128.0\node_modules\wrangler\bin\wrangler.js'

q = ("SELECT s.room_id AS rid, json_extract(v.data,'$.DataBlob') AS blob "
     "FROM subroom s JOIN subroom_save v ON v.sub_room_id=s.sub_room_id "
     "WHERE s.room_id BETWEEN 65 AND 76")
run = subprocess.run([node, wr, 'd1', 'execute', 'recflare', '--remote', '--json', '--command', q],
                     capture_output=True, text=True, encoding='utf-8', errors='replace')
text = run.stdout[run.stdout.index('['):]
rows = json.loads(text)[0]['results']

def code(url):
    return subprocess.run(['curl', '-s', '-o', 'NUL', '-w', '%{http_code}', url],
                          capture_output=True, text=True).stdout

for r in rows:
    rid, blob = r['rid'], r['blob']
    print('salle %-3d scene %s | image %s' % (rid, code('https://cdn.recblue.net/room/' + blob),
                                              code('https://cdn.recblue.net/room/import-%d.jpg' % rid)))
