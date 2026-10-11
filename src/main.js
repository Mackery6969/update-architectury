import { appendFileSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { dryRun, GitHubClient } from './github.js';
import { log } from './log.js';
import { MavenRegistry } from './maven.js';
import { Updater } from './updater.js';

export async function main(env = process.env) {
  const config = loadConfig(env);
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is not set.');
  const eventName = env.GITHUB_EVENT_NAME || 'workflow_dispatch';
  const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};

  let github = new GitHubClient({ token: config.token, owner, repo, apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL });
  if (config.dryRun) {
    log.info('Dry run: nothing will be pushed, opened, closed or commented on.');
    github = dryRun(github, log);
  }
  const updater = new Updater({ github, registry: new MavenRegistry(config.registry), config, log });
  await updater.run(eventName, payload);

  const summary = updater.summary();
  if (summary) {
    log.info(summary);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  return updater.failed ? 1 : 0;
}
