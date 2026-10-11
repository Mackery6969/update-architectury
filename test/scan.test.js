import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isArchitectury } from '../src/config.js';
import { isCandidate, scanFiles } from '../src/scan.js';
import { buildUnits, planUpdate } from '../src/units.js';

const scan = (files) => {
  const map = new Map(Object.entries(files));
  const result = scanFiles(map, { include: isArchitectury });
  return { ...result, files: map, units: buildUnits(result.deps) };
};

const describeDeps = (deps) =>
  Object.fromEntries(deps.map((dep) => [dep.name, dep.occurrences.map(({ source }) => `${source.file} ${source.kind}${source.name ? `:${source.name}` : ''} ${source.value}`)]));

// The layout of Architectury's project templates.
const groovyTemplate = {
  'settings.gradle': `pluginManagement {
    repositories {
        maven { url "https://maven.architectury.dev/" }
        gradlePluginPortal()
    }
}
include("common", "fabric", "neoforge")
`,
  'build.gradle': `plugins {
    id "dev.architectury.loom" version "1.11-SNAPSHOT" apply false
    id 'architectury-plugin' version '3.4-SNAPSHOT'
    id "com.github.johnrengelman.shadow" version "8.1.1" apply false
}

architectury {
    minecraft = project.minecraft_version
}

allprojects {
    // modApi "dev.architectury:architectury:1.0.0"
    /* modApi "dev.architectury:architectury:2.0.0" */
}
`,
  'gradle.properties': 'org.gradle.jvmargs=-Xmx2G\nminecraft_version=1.21.1\narchitectury_api_version = 13.0.8\r\n',
  'common/build.gradle': `dependencies {
    modImplementation "dev.architectury:architectury:\${rootProject.architectury_api_version}"
}
`,
  'fabric/build.gradle': `plugins {
    id "dev.architectury.loom"
}
dependencies {
    modApi "dev.architectury:architectury-fabric:$rootProject.architectury_api_version"
}
`,
  'neoforge/build.gradle': `dependencies {
    modApi "dev.architectury:architectury-neoforge:\${rootProject.architectury_api_version}"
}
`,
};

test('finds the declarations of an Architectury template project', () => {
  const result = scan(groovyTemplate);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(describeDeps(result.deps), {
    'architectury-plugin': ['build.gradle inline 3.4-SNAPSHOT'],
    'dev.architectury.loom': ['build.gradle inline 1.11-SNAPSHOT'],
    'dev.architectury:architectury': ['gradle.properties property:architectury_api_version 13.0.8'],
    'dev.architectury:architectury-fabric': ['gradle.properties property:architectury_api_version 13.0.8'],
    'dev.architectury:architectury-neoforge': ['gradle.properties property:architectury_api_version 13.0.8'],
  });
  assert.deepEqual(
    result.units.map((unit) => [unit.name, unit.current, unit.deps.length]),
    [
      ['architectury_api_version', '13.0.8', 3],
      ['architectury-plugin', '3.4-SNAPSHOT', 1],
      ['dev.architectury.loom', '1.11-SNAPSHOT', 1],
    ],
  );
});

test('edits a shared property once for every artifact using it', () => {
  const result = scan(groovyTemplate);
  const unit = result.units.find((candidate) => candidate.property === 'architectury_api_version');
  const plan = planUpdate(result, new Map(unit.deps.map((dep) => [dep.name, '13.0.9'])));
  assert.equal(plan.property, 'architectury_api_version');
  assert.deepEqual([...plan.files.keys()], ['gradle.properties']);
  assert.equal(plan.files.get('gradle.properties'), 'org.gradle.jvmargs=-Xmx2G\nminecraft_version=1.21.1\narchitectury_api_version = 13.0.9\r\n');
  assert.deepEqual(
    plan.updates.map((update) => `${update.name} ${update.from} -> ${update.to}`),
    [
      'dev.architectury:architectury 13.0.8 -> 13.0.9',
      'dev.architectury:architectury-fabric 13.0.8 -> 13.0.9',
      'dev.architectury:architectury-neoforge 13.0.8 -> 13.0.9',
    ],
  );

  const loom = planUpdate(result, new Map([['dev.architectury.loom', '1.17.493']]));
  assert.match(loom.files.get('build.gradle'), /id "dev\.architectury\.loom" version "1\.17\.493" apply false/);
  assert.equal(loom.files.get('build.gradle').length, groovyTemplate['build.gradle'].length - '1.11-SNAPSHOT'.length + '1.17.493'.length);
});

test('resolves Kotlin DSL, version catalogs and script variables', () => {
  const result = scan({
    'build.gradle.kts': `plugins {
    id("dev.architectury.loom") version "1.14.473" apply false
    id("architectury-plugin").version(libs.versions.arch.plugin.get())
}

dependencies {
    "modApi"("dev.architectury:architectury-fabric:\${property("architectury_api_version")}")
    implementation(group = "dev.architectury", name = "architectury-transformer", version = "5.2.87")
    modApi("dev.architectury:architectury:$apiVersion")
}

val apiVersion = "13.0.8"
`,
    'gradle.properties': 'architectury_api_version=13.0.8\n',
    'gradle/libs.versions.toml': `[versions]
arch-plugin = "3.4.161" # the plugin
api = { strictly = "13.0.8" }

[libraries]
architectury-neoforge = { module = "dev.architectury:architectury-neoforge", version.ref = "api" }
architectury-common = { group = "dev.architectury", name = "architectury", version = "13.0.7" }
fabric-loader = { module = "net.fabricmc:fabric-loader", version = "0.16.0" }

[plugins]
loom = { id = "dev.architectury.loom", version = "1.13.467" }
arch = "architectury-plugin:3.4.161"
`,
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(describeDeps(result.deps), {
    'architectury-plugin': ['gradle/libs.versions.toml catalog:arch-plugin 3.4.161', 'gradle/libs.versions.toml inline 3.4.161'],
    'dev.architectury.loom': ['build.gradle.kts inline 1.14.473', 'gradle/libs.versions.toml inline 1.13.467'],
    'dev.architectury:architectury': ['build.gradle.kts variable:apiVersion 13.0.8', 'gradle/libs.versions.toml inline 13.0.7'],
    'dev.architectury:architectury-fabric': ['gradle.properties property:architectury_api_version 13.0.8'],
    'dev.architectury:architectury-neoforge': ['gradle/libs.versions.toml catalog:api 13.0.8'],
    'dev.architectury:architectury-transformer': ['build.gradle.kts inline 5.2.87'],
  });

  // Each declaration of loom moves to the target; the newest one sets nothing back.
  const plan = planUpdate(result, new Map([['dev.architectury.loom', '1.17.493']]));
  assert.deepEqual(plan.updates, [{ name: 'dev.architectury.loom', kind: 'plugin', from: '1.13.467', to: '1.17.493' }]);
  assert.match(plan.files.get('build.gradle.kts'), /version "1\.17\.493" apply false/);
  assert.match(plan.files.get('gradle/libs.versions.toml'), /loom = \{ id = "dev\.architectury\.loom", version = "1\.17\.493" \}/);
});

test('reports declarations it cannot resolve and skips dynamic versions', () => {
  const result = scan({
    'build.gradle': `dependencies {
    modApi "dev.architectury:architectury:\${missing_property}"
    modApi "dev.architectury:architectury-fabric:13.+"
    modApi "dev.architectury:architectury-neoforge:\${mc}-1"
}
`,
  });
  assert.deepEqual(result.deps, []);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /dev\.architectury:architectury declared at build\.gradle:2/);
  assert.match(result.notices[0], /13\.\+/);
});

test('reads gradle.properties of enclosing directories', () => {
  const result = scan({
    'gradle.properties': 'loom_version=1.14.473\n',
    'mc26/settings.gradle': `pluginManagement {
    plugins {
        id 'dev.architectury.loom' version loom_version
    }
}
`,
  });
  assert.deepEqual(describeDeps(result.deps), { 'dev.architectury.loom': ['gradle.properties property:loom_version 1.14.473'] });
});

test('picks the files that can declare versions', () => {
  assert.ok(isCandidate('build.gradle.kts', ''));
  assert.ok(isCandidate('common/build.gradle', ''));
  assert.ok(isCandidate('gradle/libs.versions.toml', ''));
  assert.ok(!isCandidate('build/tmp/x.gradle', ''));
  assert.ok(!isCandidate('fabric/.gradle/loom-cache/a.gradle', ''));
  assert.ok(!isCandidate('src/main/java/A.java', ''));
  assert.ok(isCandidate('mc26/fabric/build.gradle.kts', 'mc26'));
  assert.ok(!isCandidate('common/build.gradle.kts', 'mc26'));
  assert.ok(isCandidate('gradle.properties', 'mc26'));
  assert.ok(isCandidate('gradle/libs.versions.toml', 'mc26'));
  assert.ok(!isCandidate('common/gradle.properties', 'mc26'));
});
