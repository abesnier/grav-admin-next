import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lucide icons that plugins name at runtime ("shield-check", "ShieldCheck"),
 * served as small lazy chunks instead of the whole icon set.
 *
 * `virtual:lucide-icons/<letter>` exports every icon whose component name
 * starts with that letter, keyed by that name. `virtual:lucide-icons/aliases`
 * maps lucide's old names to the current ones. Both are built from the
 * installed lucide-svelte, so an upgrade needs no regeneration step. See
 * src/lib/utils/lucide-icon.ts.
 */
function lucideIconBuckets(): Plugin {
	const PREFIX = 'virtual:lucide-icons/';
	let buckets: Map<string, Map<string, string>> | null = null;
	let aliases: Record<string, string> | null = null;

	function scan() {
		if (buckets && aliases) return;
		const dist = dirname(createRequire(import.meta.url).resolve('lucide-svelte'));
		const exportsOf = (file: string) => {
			// Strip comments first: lucide's `@deprecated` notes sit inside the braces.
			const src = readFileSync(resolve(dist, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
			const out: Array<[string, string]> = [];
			for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
				const kebab = m[2].replace(/^.*\//, '').replace(/\.(svelte|js)$/, '');
				for (const n of m[1].matchAll(/default\s+as\s+(\w+)/g)) out.push([n[1], kebab]);
			}
			return out;
		};

		buckets = new Map();
		const canonical = new Map<string, string>();
		for (const [name, kebab] of exportsOf('icons/index.js')) {
			const letter = name[0].toLowerCase();
			if (!buckets.has(letter)) buckets.set(letter, new Map());
			buckets.get(letter)!.set(name, kebab);
			canonical.set(kebab, name);
		}
		// An alias export points at a stub (icons/alert-circle.js) that re-exports
		// the current icon (./circle-alert.svelte); follow it to the current name.
		aliases = {};
		for (const [name, stub] of exportsOf('aliases/aliases.js')) {
			let target = canonical.get(stub);
			if (!target) {
				const src = readFileSync(resolve(dist, `icons/${stub}.js`), 'utf8');
				const current = src.match(/from\s*['"]\.\/([\w-]+)\.svelte['"]/)?.[1];
				target = current ? canonical.get(current) : undefined;
			}
			if (target && target !== name) aliases[name] = target;
		}
	}

	return {
		name: 'grav-lucide-icon-buckets',
		resolveId(id) {
			return id.startsWith(PREFIX) ? '\0' + id : null;
		},
		load(id) {
			if (!id.startsWith('\0' + PREFIX)) return null;
			scan();
			const key = id.slice(PREFIX.length + 1);
			if (key === 'aliases') return `export default ${JSON.stringify(aliases)};`;
			const icons = buckets!.get(key);
			if (!icons) return 'export default {};';
			const lines: string[] = [];
			const entries: string[] = [];
			let i = 0;
			for (const [name, kebab] of icons) {
				lines.push(`import I${i} from 'lucide-svelte/icons/${kebab}';`);
				entries.push(`${JSON.stringify(name)}: I${i}`);
				i++;
			}
			return `${lines.join('\n')}\nexport default { ${entries.join(', ')} };`;
		}
	};
}

/**
 * The lucide icons our own source names (`import { X } from 'lucide-svelte'`),
 * as their file names in lucide-svelte/dist/icons. Icons reached only through
 * the lazy `virtual:lucide-icons/*` buckets are not in this set.
 */
function sourceNamedIcons(): Set<string> {
	const dist = dirname(createRequire(import.meta.url).resolve('lucide-svelte'));
	const files = new Map<string, string>();
	const icons = readFileSync(resolve(dist, 'icons/index.js'), 'utf8');
	for (const m of icons.matchAll(/default as (\w+)\s*\}\s*from\s*'\.\/([\w-]+)\.svelte'/g)) {
		files.set(m[1], m[2]);
	}
	const aliases = readFileSync(resolve(dist, 'aliases/aliases.js'), 'utf8');
	for (const m of aliases.matchAll(/default as (\w+)\s*\}\s*from\s*'\.\.\/icons\/([\w-]+)\.js'/g)) {
		const stub = readFileSync(resolve(dist, `icons/${m[2]}.js`), 'utf8');
		const file = stub.match(/\.\/([\w-]+)\.svelte/)?.[1];
		if (file) files.set(m[1], file);
	}

	const named = new Set<string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(ts|js|svelte)$/.test(entry.name)) {
				const src = readFileSync(path, 'utf8');
				for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-svelte['"]/g)) {
					for (const spec of m[1].split(',')) {
						const file = files.get(spec.trim().split(/\s+as\s+/)[0]);
						if (file) named.add(file);
					}
				}
			}
		}
	};
	walk(resolve(dirname(fileURLToPath(import.meta.url)), 'src'));
	return named;
}

/**
 * Fewer, larger chunks on first load (admin2#181). Left alone, Rollup gives
 * every module shared between the shell and a lazy route its own chunk, so the
 * shell modulepreloaded ~75 files, 50 of them under 1 KB. Hosts whose proxy
 * rate-limits bursts turn one of those into a 503/429 and the admin fails to
 * boot. Two groups cover most of them without moving lazy code into the first
 * load: the Svelte runtime, which the shell needs almost all of anyway, and
 * the icons our own components import by name.
 *
 * Not `output.experimentalMinChunkSize`: it merges small chunks into whichever
 * chunk loads "under similar conditions", which pulled the Font Awesome map
 * and CodeMirror modes into the shell (+42% gzip on first load).
 */
function clientChunkGroups(): Plugin {
	let ssr = false;
	let icons: Set<string> | null = null;
	const group = (id: string) => {
		if (/[\\/]node_modules[\\/]svelte[\\/]src[\\/]/.test(id)) return 'svelte';
		const icon = id.match(/[\\/]node_modules[\\/]lucide-svelte[\\/]dist[\\/]icons[\\/]([\w-]+)\.svelte$/);
		if (icon) {
			icons ??= sourceNamedIcons();
			if (icons.has(icon[1])) return 'icons';
		}
		return undefined;
	};
	return {
		name: 'grav-client-chunk-groups',
		apply: 'build',
		configResolved(config) {
			ssr = !!config.build.ssr;
		},
		outputOptions(options) {
			// Client bundle only; the server build just prerenders the fallback shell.
			return ssr ? null : { ...options, manualChunks: group };
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), lucideIconBuckets(), clientChunkGroups(), sveltekit()],
	server: {
		proxy: {
			// Proxy all Grav requests (API + media files) during development
			'/grav-api': {
				target: 'https://localhost',
				changeOrigin: true,
				secure: false // allow self-signed certs
			}
		}
	}
});
