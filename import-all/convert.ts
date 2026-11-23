import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'

import { downgradeRoom } from '../recflare-serveur/apps/www/src/room-converter'

const TARGET = 23
const src = 'import-all/raw'
const out = 'import-all/up'
mkdirSync(out, { recursive: true })

const readVarint = (b: Uint8Array, i: number): [number, number] => {
	let shift = 0
	let value = 0
	for (;;) {
		const byte = b[i++]
		value |= (byte & 0x7f) << shift
		shift += 7
		if ((byte & 0x80) === 0) return [value, i]
	}
}

const rows: string[] = []
for (const name of readdirSync(src)) {
	const raw = new Uint8Array(readFileSync(`${src}/${name}`))
	const { data, stats } = downgradeRoom(raw)
	const buf = new Uint8Array(data)
	// Patch the top-level version field (fn30) down to what this client reads.
	let i = 0
	while (i < buf.length) {
		let key: number
		;[key, i] = readVarint(buf, i)
		const fn = key >> 3
		const wt = key & 7
		if (wt === 0) {
			const vstart = i
			let v: number
			;[v, i] = readVarint(buf, i)
			if (fn === 30) {
				buf[vstart] = TARGET
				break
			}
		} else if (wt === 2) {
			let len: number
			;[len, i] = readVarint(buf, i)
			i += len
		} else if (wt === 5) i += 4
		else if (wt === 1) i += 8
		else break
	}
	writeFileSync(`${out}/${name}`, buf)
	rows.push(`${name}: ${stats.originalVersion}:${stats.inputBytes} -> ${TARGET}:${buf.length}`)
}
console.log(rows.join('\n'))
