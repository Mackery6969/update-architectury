import { execFile } from 'node:child_process';

export class RegistryError extends Error {}

// maven.architectury.dev sits behind Cloudflare's bot protection, which is
// what stops Dependabot. Plain curl from a GitHub-hosted runner gets through,
// so metadata is fetched with curl rather than Node's fetch.
export class MavenRegistry {
  constructor(baseUrl, { fetchText = curl, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.fetchText = fetchText;
    this.sleep = sleep;
    this.cache = new Map();
  }

  metadataUrl(dep) {
    if (dep.kind === 'plugin') return `${this.baseUrl}${dep.name.replaceAll('.', '/')}/${dep.name}.gradle.plugin/maven-metadata.xml`;
    const [group, artifact] = dep.name.split(':');
    return `${this.baseUrl}${group.replaceAll('.', '/')}/${artifact}/maven-metadata.xml`;
  }

  versions(dep) {
    const url = this.metadataUrl(dep);
    if (!this.cache.has(url)) this.cache.set(url, this.load(url));
    return this.cache.get(url);
  }

  async load(url) {
    for (let attempt = 1; ; attempt++) {
      const { status, body } = await this.fetchText(url);
      if (status === 200 && /<metadata[\s>]/.test(body)) return parseMetadata(body);
      if (status === 404) throw new RegistryError(`${url} does not exist (HTTP 404).`);
      if (attempt >= 3) {
        const page = /<html|<!doctype html/i.test(body);
        throw new RegistryError(
          page
            ? `${url} answered HTTP ${status} with a web page instead of maven-metadata.xml. That is usually Cloudflare's bot protection; try again later.`
            : `${url} could not be read (${status ? `HTTP ${status}` : body.trim() || 'network error'}).`,
        );
      }
      await this.sleep(attempt * 5000);
    }
  }
}

export function parseMetadata(xml) {
  const versions = /<versions>([\s\S]*?)<\/versions>/.exec(xml)?.[1] ?? '';
  return [...new Set([...versions.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((match) => match[1]))];
}

function curl(url) {
  return new Promise((resolve, reject) => {
    const args = ['--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '20', '--max-time', '90', '--write-out', '\n%{http_code}', url];
    execFile('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') {
        reject(new RegistryError('curl is required to read maven metadata, but it is not installed on this runner.'));
      } else if (error) {
        resolve({ status: 0, body: stderr || error.message });
      } else {
        const cut = stdout.lastIndexOf('\n');
        resolve({ status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) });
      }
    });
  });
}
