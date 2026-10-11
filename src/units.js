import { compareVersions, maxVersion, minVersion } from './version.js';

// Dependencies whose versions are written in the same place (a shared
// gradle.properties key, catalog version, ...) can only move together, so
// they form one unit and get one pull request, as Dependabot does for
// property-based versions.
export function buildUnits(deps) {
  const parent = new Map();
  const find = (node) => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(node, root);
    return root;
  };
  const add = (node) => parent.has(node) || parent.set(node, node);
  for (const dep of deps) {
    add(`dep:${dep.name}`);
    for (const { source } of dep.occurrences) {
      add(`source:${source.key}`);
      const a = find(`dep:${dep.name}`);
      const b = find(`source:${source.key}`);
      if (a !== b) parent.set(a, b);
    }
  }
  const groups = new Map();
  for (const dep of deps) {
    const root = find(`dep:${dep.name}`);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(dep);
  }
  return [...groups.values()].map(unitOf).sort((a, b) => a.name.localeCompare(b.name));
}

function unitOf(deps) {
  const sources = new Map();
  for (const dep of deps) for (const { source } of dep.occurrences) sources.set(source.key, source);
  const sourceList = [...sources.values()];
  const property = deps.length > 1 && sourceList.length === 1 ? sourceList[0].name : null;
  return {
    deps: deps.map((dep) => ({ ...dep, current: currentVersion(dep) })),
    sources: sourceList,
    property,
    name: property ?? deps.map((dep) => dep.name).join(', '),
    current: minVersion(sourceList.map((source) => source.value)),
  };
}

export function currentVersion(dep) {
  return minVersion(dep.occurrences.map(({ source }) => source.value));
}

// Works out the file changes that move each dependency in `targets`
// (name -> version) to its target. Declarations already at or above the
// target are left alone.
export function planUpdate(snapshot, targets) {
  const edits = new Map();
  const updates = [];
  for (const dep of snapshot.deps) {
    const to = targets.get(dep.name);
    if (!to) continue;
    const from = currentVersion(dep);
    if (compareVersions(from, to) >= 0) continue;
    updates.push({ name: dep.name, kind: dep.kind, from, to });
    for (const { source } of dep.occurrences) {
      if (compareVersions(source.value, to) >= 0) continue;
      const previous = edits.get(source.key);
      edits.set(source.key, { source, to: previous ? maxVersion([previous.to, to]) : to });
    }
  }
  const unit = snapshot.units.find((candidate) => candidate.deps.some((dep) => targets.has(dep.name)));
  const property = unit?.property && unit.deps.every((dep) => targets.has(dep.name)) ? unit.property : null;
  return { files: applyEdits(snapshot.files, [...edits.values()]), updates, property };
}

function applyEdits(files, edits) {
  const byFile = new Map();
  for (const edit of edits) {
    if (!byFile.has(edit.source.file)) byFile.set(edit.source.file, []);
    byFile.get(edit.source.file).push(edit);
  }
  const changed = new Map();
  for (const [file, fileEdits] of byFile) {
    let content = files.get(file);
    for (const { source, to } of fileEdits.sort((a, b) => b.source.start - a.source.start)) {
      if (content.slice(source.start, source.end) !== source.value) {
        throw new Error(`${file} does not contain "${source.value}" where it was found; refusing to edit it.`);
      }
      content = content.slice(0, source.start) + to + content.slice(source.end);
    }
    changed.set(file, content);
  }
  return changed;
}
