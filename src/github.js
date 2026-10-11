const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(method, url, status, body) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = [parsed.message, ...(parsed.errors ?? []).map((error) => error.message ?? JSON.stringify(error))].filter(Boolean).join(': ');
    } catch {
      // keep the raw body
    }
    super(`${method} ${url.pathname} failed with HTTP ${status}: ${detail}`);
    this.status = status;
  }
}

const PULL_FIELDS = `id number title body state merged url headRefName headRefOid baseRefName isCrossRepository mergeable author { login } autoMergeRequest { enabledAt }`;

function pullFromGraphql(node) {
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    state: node.state === 'OPEN' ? 'open' : 'closed',
    merged: node.merged,
    url: node.url,
    headRef: node.headRefName,
    headSha: node.headRefOid,
    baseRef: node.baseRefName,
    crossRepository: node.isCrossRepository,
    mergeable: node.mergeable === 'MERGEABLE' ? true : node.mergeable === 'CONFLICTING' ? false : null,
    author: node.author?.login ?? null,
    autoMerge: Boolean(node.autoMergeRequest),
  };
}

function pullFromRest(pr) {
  return {
    id: pr.node_id,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    merged: Boolean(pr.merged_at),
    url: pr.html_url,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    crossRepository: pr.head.repo?.full_name !== pr.base.repo?.full_name,
    mergeable: pr.mergeable ?? null,
    author: pr.user?.login ?? null,
    autoMerge: Boolean(pr.auto_merge),
  };
}

const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');

export class GitHubClient {
  constructor({ token, owner, repo, apiUrl = 'https://api.github.com', graphqlUrl }) {
    if (!token) throw new Error('A GitHub token is required.');
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.graphqlUrl = graphqlUrl ?? `${this.apiUrl}/graphql`;
    this.path = `/repos/${owner}/${repo}`;
  }

  async request(method, path, { body, query, allow = [] } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.token}`,
            'user-agent': 'update-architectury',
            'x-github-api-version': '2022-11-28',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt < 4) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }
      const text = await response.text();
      if (response.ok) return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
      if (allow.includes(response.status)) return { status: response.status, data: null, headers: response.headers };
      const limited = response.status === 429 || (response.status === 403 && (response.headers.get('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'));
      if ((limited || response.status >= 500) && attempt < 4) {
        const retryAfter = Number(response.headers.get('retry-after')) * 1000;
        await sleep(Math.min(retryAfter || 2000 * 2 ** attempt, 60_000));
        continue;
      }
      throw new HttpError(method, url, response.status, text);
    }
  }

  async graphql(query, variables) {
    const { data } = await this.request('POST', this.graphqlUrl, { body: { query, variables } });
    if (data.errors?.length) throw new Error(data.errors.map((error) => error.message).join('; '));
    return data.data;
  }

  async getRepo() {
    const { data } = await this.request('GET', this.path);
    return { defaultBranch: data.default_branch, allowMergeCommit: data.allow_merge_commit, allowSquashMerge: data.allow_squash_merge };
  }

  async getBranchHead(branch) {
    const { data: ref } = await this.request('GET', `${this.path}/git/ref/heads/${refPath(branch)}`, { allow: [404] });
    if (!ref) return null;
    const { data: commit } = await this.request('GET', `${this.path}/git/commits/${ref.object.sha}`);
    return { sha: commit.sha, treeSha: commit.tree.sha };
  }

  async branchExists(branch) {
    const { data } = await this.request('GET', `${this.path}/git/ref/heads/${refPath(branch)}`, { allow: [404] });
    return Boolean(data);
  }

  async getTree(treeSha) {
    const { data } = await this.request('GET', `${this.path}/git/trees/${treeSha}`, { query: { recursive: '1' } });
    return { entries: data.tree, truncated: data.truncated };
  }

  async getBlob(sha) {
    const { data } = await this.request('GET', `${this.path}/git/blobs/${sha}`);
    return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }

  async createCommit({ parent, baseTree, files, message }) {
    const tree = [...files].map(([path, { content, mode }]) => ({ path, mode, type: 'blob', content }));
    const { data: newTree } = await this.request('POST', `${this.path}/git/trees`, { body: { base_tree: baseTree, tree } });
    const { data: commit } = await this.request('POST', `${this.path}/git/commits`, { body: { message, tree: newTree.sha, parents: [parent] } });
    return commit.sha;
  }

  async setBranch(branch, sha) {
    const { status } = await this.request('PATCH', `${this.path}/git/refs/heads/${refPath(branch)}`, { body: { sha, force: true }, allow: [404, 422] });
    if (status === 404 || status === 422) await this.request('POST', `${this.path}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } });
  }

  async deleteBranch(branch) {
    await this.request('DELETE', `${this.path}/git/refs/heads/${refPath(branch)}`, { allow: [404, 422] });
  }

  async recentCommits(branch, count = 20) {
    const { data } = await this.request('GET', `${this.path}/commits`, { query: { sha: branch, per_page: String(count) } });
    return data.map((commit) => ({ message: commit.commit.message, author: commit.author?.login ?? null, parents: commit.parents.length }));
  }

  async listPulls() {
    const query = `query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes { ${PULL_FIELDS} }
        }
      }
    }`;
    const pulls = [];
    let cursor = null;
    do {
      const data = await this.graphql(query, { owner: this.owner, repo: this.repo, cursor });
      const page = data.repository.pullRequests;
      pulls.push(...page.nodes.map(pullFromGraphql));
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return pulls;
  }

  async getPull(number) {
    const { data } = await this.request('GET', `${this.path}/pulls/${number}`);
    return pullFromRest(data);
  }

  async createPull({ title, body, head, base }) {
    const { data } = await this.request('POST', `${this.path}/pulls`, { body: { title, body, head, base } });
    return pullFromRest(data);
  }

  async updatePull(number, fields) {
    await this.request('PATCH', `${this.path}/pulls/${number}`, { body: fields });
  }

  async mergePull(number, method) {
    await this.request('PUT', `${this.path}/pulls/${number}/merge`, { body: { merge_method: method } });
  }

  async enableAutoMerge(pullId, method) {
    await this.graphql(
      `mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }`,
      { id: pullId, method: method.toUpperCase() },
    );
  }

  async disableAutoMerge(pullId) {
    await this.graphql(`mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`, { id: pullId });
  }

  async comment(number, body) {
    await this.request('POST', `${this.path}/issues/${number}/comments`, { body: { body } });
  }

  async react(commentId, content) {
    await this.request('POST', `${this.path}/issues/comments/${commentId}/reactions`, { body: { content } });
  }

  async labelExists(name) {
    const { data } = await this.request('GET', `${this.path}/labels/${encodeURIComponent(name)}`, { allow: [404] });
    return Boolean(data);
  }

  async createLabel(name, color, description) {
    await this.request('POST', `${this.path}/labels`, { body: { name, color, description }, allow: [422] });
  }

  async addLabels(number, labels) {
    await this.request('POST', `${this.path}/issues/${number}/labels`, { body: { labels } });
  }

  async addAssignees(number, assignees) {
    await this.request('POST', `${this.path}/issues/${number}/assignees`, { body: { assignees } });
  }

  async requestReviewers(number, reviewers, teamReviewers) {
    await this.request('POST', `${this.path}/pulls/${number}/requested_reviewers`, { body: { reviewers, team_reviewers: teamReviewers } });
  }

  async setMilestone(number, milestone) {
    await this.request('PATCH', `${this.path}/issues/${number}`, { body: { milestone } });
  }

  async permission(username) {
    const { data } = await this.request('GET', `${this.path}/collaborators/${encodeURIComponent(username)}/permission`);
    return data.permission;
  }

  async dispatchWorkflow(workflow, ref) {
    await this.request('POST', `${this.path}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { body: { ref } });
  }

  async releases(repository) {
    const { data } = await this.request('GET', `/repos/${repository}/releases`, { query: { per_page: '100' }, allow: [403, 404] });
    return (data ?? []).map((release) => ({
      tag: release.tag_name,
      name: release.name,
      body: release.body ?? '',
      url: release.html_url,
      draft: release.draft,
      prerelease: release.prerelease,
    }));
  }
}

const WRITES = {
  createCommit: () => '0000000000000000000000000000000000000000',
  setBranch: () => undefined,
  deleteBranch: () => undefined,
  createPull: ({ title, head, base }) => ({ id: 'dry-run', number: 0, title, body: '', state: 'open', merged: false, url: '(dry run)', headRef: head, headSha: '', baseRef: base, crossRepository: false, mergeable: null, author: null, autoMerge: false }),
  updatePull: () => undefined,
  mergePull: () => undefined,
  enableAutoMerge: () => undefined,
  disableAutoMerge: () => undefined,
  comment: () => undefined,
  react: () => undefined,
  createLabel: () => undefined,
  addLabels: () => undefined,
  addAssignees: () => undefined,
  requestReviewers: () => undefined,
  setMilestone: () => undefined,
  dispatchWorkflow: () => undefined,
};

// Wraps a client so every write is logged instead of performed.
export function dryRun(client, log) {
  return new Proxy(client, {
    get(target, property) {
      if (Object.hasOwn(WRITES, property)) {
        return async (...args) => {
          const summary = args
            .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg, (key, value) => (value instanceof Map ? [...value.keys()] : value))))
            .join(' | ');
          log.info(`[dry run] ${property}: ${summary.length > 300 ? `${summary.slice(0, 300)}...` : summary}`);
          return WRITES[property](...args);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
