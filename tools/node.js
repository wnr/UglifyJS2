// workaround for tty output truncation upon process.exit()
[process.stdout, process.stderr].forEach(function(stream){
    if (stream._handle && stream._handle.setBlocking)
        stream._handle.setBlocking(true);
});

var path = require("path");
var fs = require("fs");

var FILES = exports.FILES = [
    "../lib/utils.js",
    "../lib/ast.js",
    "../lib/parse.js",
    "../lib/transform.js",
    "../lib/scope.js",
    "../lib/output.js",
    "../lib/compress.js",
    "../lib/sourcemap.js",
    "../lib/mozilla-ast.js",
    "../lib/propmangle.js",
    "./exports.js",
].map(function(file){
    return fs.realpathSync(path.join(path.dirname(__filename), file));
});

var UglifyJS = exports;

new Function("MOZ_SourceMap", "exports", "DEBUG", FILES.map(function(file){
    return fs.readFileSync(file, "utf8");
}).join("\n\n"))(
    require("source-map"),
    UglifyJS,
    !!global.UGLIFY_DEBUG
);

UglifyJS.AST_Node.warn_function = function(txt) {
    console.error("WARN: %s", txt);
};

exports.minify = function(files, options) {
    options = UglifyJS.defaults(options, {
        spidermonkey     : false,
        outSourceMap     : null,
        sourceRoot       : null,
        inSourceMap      : null,
        sourceMapUrl     : null,
        fromString       : false,
        warnings         : false,
        mangle           : {},
        mangleProperties : false,
        nameCache        : null,
        output           : null,
        compress         : {},
        parse            : {}
    });
    UglifyJS.base54.reset();

    // 1. parse
    var toplevel = null,
        sourcesContent = {};

    if (options.spidermonkey) {
        toplevel = UglifyJS.AST_Node.from_mozilla_ast(files);
    } else {
        function addFile(file, fileUrl) {
            var code = options.fromString
                ? file
                : fs.readFileSync(file, "utf8");
            sourcesContent[fileUrl] = code;
            toplevel = UglifyJS.parse(code, {
                filename: fileUrl,
                toplevel: toplevel,
                bare_returns: options.parse ? options.parse.bare_returns : undefined
            });
        }
        [].concat(files).forEach(function (files, i) {
            if (typeof files === 'string') {
                addFile(files, options.fromString ? i : files);
            } else {
                for (var fileUrl in files) {
                    addFile(files[fileUrl], fileUrl);
                }
            }
        });
    }
    if (options.wrap) {
      toplevel = toplevel.wrap_commonjs(options.wrap, options.exportAll);
    }

    // 2. compress
    if (options.compress) {
        var compress = { warnings: options.warnings };
        UglifyJS.merge(compress, options.compress);
        toplevel.figure_out_scope();
        var sq = UglifyJS.Compressor(compress);
        toplevel = sq.compress(toplevel);
    }

    // 3. mangle properties
    if (options.mangleProperties || options.nameCache) {
        options.mangleProperties.cache = UglifyJS.readNameCache(options.nameCache, "props");
        toplevel = UglifyJS.mangle_properties(toplevel, options.mangleProperties);
        UglifyJS.writeNameCache(options.nameCache, "props", options.mangleProperties.cache);
    }

    // 4. mangle
    if (options.mangle) {
        toplevel.figure_out_scope(options.mangle);
        toplevel.compute_char_frequency(options.mangle);
        toplevel.mangle_names(options.mangle);
    }

    // 5. output
    var inMap = options.inSourceMap;
    var output = {};
    if (typeof options.inSourceMap == "string") {
        inMap = JSON.parse(fs.readFileSync(options.inSourceMap, "utf8"));
    }
    if (options.outSourceMap) {
        output.source_map = UglifyJS.SourceMap({
            file: options.outSourceMap,
            orig: inMap,
            root: options.sourceRoot
        });
        if (options.sourceMapIncludeSources) {
            for (var file in sourcesContent) {
                if (sourcesContent.hasOwnProperty(file)) {
                    output.source_map.get().setSourceContent(file, sourcesContent[file]);
                }
            }
        }

    }
    if (options.output) {
        UglifyJS.merge(output, options.output);
    }
    var stream = UglifyJS.OutputStream(output);
    toplevel.print(stream);

    var mappingUrlPrefix = "\n//# sourceMappingURL=";
    if (options.outSourceMap && typeof options.outSourceMap === "string" && options.sourceMapUrl !== false) {
        stream += mappingUrlPrefix + (typeof options.sourceMapUrl === "string" ? options.sourceMapUrl : options.outSourceMap);
    }

    var source_map = output.source_map;
    if (source_map) {
        source_map = source_map + "";
    }

    return {
        code : stream + "",
        map  : source_map
    };
};

// exports.describe_ast = function() {
//     function doitem(ctor) {
//         var sub = {};
//         ctor.SUBCLASSES.forEach(function(ctor){
//             sub[ctor.TYPE] = doitem(ctor);
//         });
//         var ret = {};
//         if (ctor.SELF_PROPS.length > 0) ret.props = ctor.SELF_PROPS;
//         if (ctor.SUBCLASSES.length > 0) ret.sub = sub;
//         return ret;
//     }
//     return doitem(UglifyJS.AST_Node).sub;
// }

exports.describe_ast = function() {
    var out = UglifyJS.OutputStream({ beautify: true });
    function doitem(ctor) {
        out.print("AST_" + ctor.TYPE);
        var props = ctor.SELF_PROPS.filter(function(prop){
            return !/^\$/.test(prop);
        });
        if (props.length > 0) {
            out.space();
            out.with_parens(function(){
                props.forEach(function(prop, i){
                    if (i) out.space();
                    out.print(prop);
                });
            });
        }
        if (ctor.documentation) {
            out.space();
            out.print_string(ctor.documentation);
        }
        if (ctor.SUBCLASSES.length > 0) {
            out.space();
            out.with_block(function(){
                ctor.SUBCLASSES.forEach(function(ctor, i){
                    out.indent();
                    doitem(ctor);
                    out.newline();
                });
            });
        }
    };
    doitem(UglifyJS.AST_Node);
    return out + "";
};

function readReservedFile(filename, reserved) {
    if (!reserved) {
        reserved = { vars: [], props: [] };
    }
    var data = fs.readFileSync(filename, "utf8");
    data = JSON.parse(data);
    if (data.vars) {
        data.vars.forEach(function(name){
            UglifyJS.push_uniq(reserved.vars, name);
        });
    }
    if (data.props) {
        data.props.forEach(function(name){
            UglifyJS.push_uniq(reserved.props, name);
        });
    }
    return reserved;
}

exports.readReservedFile = readReservedFile;

exports.readDefaultReservedFile = function(reserved) {
    return readReservedFile(path.join(__dirname, "domprops.json"), reserved);
};

exports.readNameCache = function(filename, key) {
    var cache = null;
    if (filename) {
        try {
            var cache = fs.readFileSync(filename, "utf8");
            cache = JSON.parse(cache)[key];
            if (!cache) throw "init";
            cache.props = UglifyJS.Dictionary.fromObject(cache.props);
        } catch(ex) {
            cache = {
                cname: -1,
                props: new UglifyJS.Dictionary()
            };
        }
    }
    return cache;
};

exports.writeNameCache = function(filename, key, cache) {
    if (filename) {
        var data;
        try {
            data = fs.readFileSync(filename, "utf8");
            data = JSON.parse(data);
        } catch(ex) {
            data = {};
        }
        data[key] = {
            cname: cache.cname,
            props: cache.props.toObject()
        };
        fs.writeFileSync(filename, JSON.stringify(data, null, 2), "utf8");
    }
};
