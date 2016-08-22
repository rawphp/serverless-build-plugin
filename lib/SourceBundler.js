import Promise from 'bluebird'
import path from 'path'
import fs from 'fs-extra'
import { typeOf } from 'lutils'
import { walker } from './utils'
import glob from 'minimatch'

import BabelTransform from './transforms/Babel'
import UglifyTransform from './transforms/Uglify'

Promise.promisifyAll(fs)

/**
 *  @class SourceBundler
 *
 *  Handles the inclusion of source code in the artifact.
 */
export default class SourceBundler {
    constructor(plugin, artifact) {
        this.plugin   = plugin
        this.artifact = artifact
    }

    /**
     *  Walks through, transforms, and zips source content wich
     *  is both `included` and not `excluded` by the regex or glob patterns.
     */
    async bundle({ excludes = [], includes = [], transforms }) {
        const { servicePath } = this.plugin.serverless.config

        const transforms = await this._createTransforms()

        // await this._findFilterFiles(servicePath)

        const onFile = async (root, stats, next) => {
            const relPath  = path.join(root.split(servicePath)[1], stats.name).replace(/^\/|\/$/g, '')
            const filePath = path.join(root, stats.name)

            const testPattern = (pattern) =>
                typeOf.RegExp(pattern)
                    ? pattern.test(relPath)
                    : glob(relPath, pattern, { dot: true })

            console.log(relPath, excludes.map((pattern) => {
                return { [pattern]: testPattern(pattern) }
            }))

            if ( excludes.some(testPattern) ) return next()
            if ( ! includes.some(testPattern) ) return next()

            console.log(``)
            console.log(`---- [ SourceBundler onFile ] - [ ${relPath} ]`)

            let code = await fs.readFileAsync(filePath)
            let map  = ''

            /**
             *  Runs transforms against the code, mutating the code & map
             *  with each iteration, optionally producing source maps
             */
            if ( transforms.length )
                for ( let transformer of transforms ) {
                    let result = transformer.transform({ code, map, filePath })
                    code = result.code
                    map  = result.map
                }

            // TODO: test me!!!

            this.artifact.addBuffer( new Buffer(code), relPath, this.plugin.config.zip )

            if ( map )
                this.artifact.addBuffer( new Buffer(map), `${relPath}.map`, this.plugin.config.zip )

            next()
        }

        // We never want node_modules here
        await walker(servicePath, { filters: [ /\/node_modules\//i ] })
            .on('file', onFile)
            // .on('directory') TODO: add a directories callback to match against excludes to enhance performance
            .end()

        return this.artifact
    }

    async _createTransforms() {
        const transforms = []

        if ( this.plugin.config.method === 'babel' ) {
            let babelQuery = this.plugin.config.babel

            if ( ! babelQuery ) {
                const babelrcPath = path.join(servicePath, '.babelrc')

                babelQuery = fs.existsSync(babelrc)
                    ? JSON.parse( await fs.readFileAsync(babelrcPath) )
                    : babelQuery
            }

            transforms.push( new BabelTransform(this.plugin, babelQuery) )
        }

        if ( this.plugin.config.uglify ) {
            transforms.push( new UglifyTransform(this.plugin, this.plugin.config.uglify) )
        }

        return transforms
    }

    /**
     *  FIXME: UNUSED
     *
     *  Finds both .serverless-include and .serverless-ignore files
     *  Generates a concatenated excludes and includes list.
     *
     *  All pathing is resolved to the servicePath, so that "*" in <servicePath>/lib/.serverless-ignore
     *  will be converted to "./lib/*", a relative path.
     *
     *  @returns {Object}
     *      {
     *          includes: [ "./lib/**", ... ],
     *          excludes: [ ".git", "*", ... ]
     *      }
     *
     */
    async _findFilterFiles(rootPath) {
        const includes = []
        const excludes = []

        const parseFile = async (filePath) => {
            const parentDir = path.dirname(filePath)

            const file = await fs.readFileAsync(filePath, 'utf8')

            return file.split('\n')
                .filter((line) => /\S/.test(line) )
                .map((line) => {
                    line = line.trim()
                    line = path.join( parentDir.split(rootPath)[1] || '', line )
                        .replace(/^\/|\/$/g, '')

                    return `./${line}`
                })
        }

        await walker(rootPath, { filters: [ 'node_modules' ] })
            .on('file', async (root, { name }, next) => {
                const filePath = path.join(root, name)

                if ( name === '.serverless-ignore' ) {
                    const lines = await parseFile(filePath)
                    excludes.push(...lines)
                } else
                if ( name === '.serverless-include' ) {
                    const lines = await parseFile(filePath)
                    includes.push(...lines)
                }

                next()
            })
            .end()

        console.log({ includes, excludes })

        return { includes, excludes }
    }

}