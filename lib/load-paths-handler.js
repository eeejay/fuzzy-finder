const async = require('async')
const fs = require('fs')
const path = require('path')
const {Minimatch} = require('minimatch')
const {GitProcess} = require('dugite')

const PathsChunkSize = 100

const emittedPaths = new Set()

class PathLoader {
  constructor (rootPath, ignoreVcsIgnores, traverseSymlinkDirectories, ignoredNames) {
    this.rootPath = rootPath
    this.ignoreVcsIgnores = ignoreVcsIgnores
    this.traverseSymlinkDirectories = traverseSymlinkDirectories
    this.ignoredNames = ignoredNames
    this.paths = []
    this.inodes = new Set()
  }

  load (done) {
    this.gitLoad().catch(err => {
      return new Promise(resolve => {
        this.loadPath(this.rootPath, true, () => {
          this.flushPaths()
          resolve()
        })
      })
    }).then(done)
  }

  isIgnored (loadedPath) {
    const relativePath = path.relative(this.rootPath, loadedPath)
    for (let ignoredName of this.ignoredNames) {
      if (ignoredName.match(relativePath)) return true
    }
  }

  pathLoaded (loadedPath, done) {
    if (!this.isIgnored(loadedPath) && !emittedPaths.has(loadedPath)) {
      this.paths.push(loadedPath)
      emittedPaths.add(loadedPath)
    }

    if (this.paths.length === PathsChunkSize) {
      this.flushPaths()
    }
    done()
  }

  flushPaths () {
    emit('load-paths:paths-found', this.paths)
    this.paths = []
  }

  gitLoad () {
    return GitProcess.exec(["root"], this.rootPath).then(res => {
      if (res.exitCode != 0 || res.stdout.trim() != this.rootPath) {
        throw "Not in root of a git project"
      }

      return new Promise(resolve => {
        let args = ['ls-files', '--cached', '--others', '-z']
        if (this.ignoreVcsIgnores) {
          args.push('--exclude-standard')
        }
        for (let ignoredName of this.ignoredNames) {
          args.push('--exclude')
          args.push(ignoredName.pattern)
        }
        let output = ''
        let startTime = Date.now()
        let proc = GitProcess.spawn(args, this.rootPath)
        proc.stdout.on('data', chunk => {
          let files = (output + chunk).split('\0')
          output = files.pop()
          emit('load-paths:paths-found', files)
        })
        proc.on('close', chunk => {
          resolve()
        })
      })
    })
  }

  loadPath (pathToLoad, root, done) {
    if (this.isIgnored(pathToLoad) && !root) return done()

    fs.lstat(pathToLoad, (error, stats) => {
      if (error != null) { return done() }
      if (stats.isSymbolicLink()) {
        fs.stat(pathToLoad, (error, stats) => {
          if (error != null) return done()
          if (this.inodes.has(stats.ino)) {
            return done()
          } else {
            this.inodes.add(stats.ino)
          }

          if (stats.isFile()) {
            this.pathLoaded(pathToLoad, done)
          } else if (stats.isDirectory()) {
            if (this.traverseSymlinkDirectories) {
              this.loadFolder(pathToLoad, done)
            } else {
              done()
            }
          } else {
            done()
          }
        })
      } else {
        this.inodes.add(stats.ino)
        if (stats.isDirectory()) {
          this.loadFolder(pathToLoad, done)
        } else if (stats.isFile()) {
          this.pathLoaded(pathToLoad, done)
        } else {
          done()
        }
      }
    })
  }

  loadFolder (folderPath, done) {
    fs.readdir(folderPath, (_, children = []) => {
      async.each(
        children,
        (childName, next) => {
          this.loadPath(path.join(folderPath, childName), false, next)
        },
        done
      )
    })
  }
}

module.exports = function (rootPaths, followSymlinks, ignoreVcsIgnores, ignores = []) {
  const ignoredNames = []
  for (let ignore of ignores) {
    if (ignore) {
      try {
        ignoredNames.push(new Minimatch(ignore, {matchBase: true, dot: true}))
      } catch (error) {
        console.warn(`Error parsing ignore pattern (${ignore}): ${error.message}`)
      }
    }
  }

  async.each(
    rootPaths,
    (rootPath, next) =>
      new PathLoader(
        rootPath,
        ignoreVcsIgnores,
        followSymlinks,
        ignoredNames
      ).load(next)
    ,
    this.async()
  )
}
