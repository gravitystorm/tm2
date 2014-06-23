#!/usr/bin/env node

// increase the libuv threadpool size to 1.5x the number of logical CPUs.
process.env.UV_THREADPOOL_SIZE = Math.ceil(Math.max(4, require('os').cpus().length * 1.5));

process.title = 'tm2';

var path = require('path');

if (process.platform === 'win32') {
    // HOME is undefined on windows
    process.env.HOME = process.env.USERPROFILE;
    // Add custom library paths to the PATH
    process.env.PATH = path.join(__dirname,'node_modules/mapnik/lib/binding/');
}

var _ = require('underscore');
var qs = require('querystring');
var tm = require('./lib/tm');
var fs = require('fs');
var url = require('url');
var source = require('./lib/source');
var style = require('./lib/style');
var middleware = require('./lib/middleware');
var express = require('express');
var cors = require('cors');
var request = require('request');
var crypto = require('crypto');
var mapnik_omnivore = require('mapnik-omnivore');
var printer = require('abaculus');
var sm = require('sphericalmercator');
var polyline = require('polyline');

var config = require('minimist')(process.argv.slice(2));
config.db = config.db || path.join(process.env.HOME, '.tilemill', 'v2', 'app.db');
config.mapboxauth = config.mapboxauth || 'https://api.mapbox.com';
config.port = config.port || '3000';
config.test = config.test || false;
config.cwd = path.resolve(config.cwd || process.env.HOME);

tm.config(config);

var app = express();
app.use(cors());
app.use(express.bodyParser());
app.use(require('./lib/oauth'));
app.use(app.router);
app.use('/app', express.static(__dirname + '/app', { maxAge:3600e3 }));
app.use('/ext', express.static(__dirname + '/ext', { maxAge:3600e3 }));

middleware.style = [
    middleware.auth,
    middleware.exporting,
    middleware.basemap,
    middleware.loadStyle
];

middleware.source = [
    middleware.auth,
    middleware.exporting,
    middleware.loadSource
];

app.put('/style.json', middleware.writeStyle, function(req, res, next) {
    res.send({
        _recache: false,
        mtime: req.style.data.mtime,
        background: req.style.data.background
    });
});

app.get('/style.json', middleware.style, function(req, res, next) {
    res.send(req.style.data);
});

app.get('/style', middleware.style, middleware.history, function(req, res, next) {
    res.set({'content-type':'text/html'});

    // identify user's OS for styling docs shortcuts
    var agent = function() {
        var agent = req.headers['user-agent'];
        if (agent.indexOf('Win') != -1) return 'windows';
        if (agent.indexOf('Mac') != -1) return 'mac';
        if (agent.indexOf('X11') != -1 || agent.indexOf('Linux') != -1) return 'linux';
        return 'mac'; // default to Mac.
    };

    try {
        var page = tm.templates.style({
            cwd: config.cwd,
            fontsRef: require('mapnik').fonts(),
            cartoRef: require('carto').tree.Reference.data,
            sources: [req.style._backend._source.data],
            style: req.style.data,
            history: req.history,
            basemap: req.basemap,
            user: tm.db.get('user'),
            test: 'test' in req.query,
            agent: agent()
        });
    } catch(err) {
        return next(new Error('style template: ' + err.message));
    }
    return res.send(page);
});

app.get('/source/:z(\\d+)/:x(\\d+)/:y(\\d+).grid.json', middleware.source, cors(), grid);

app.get('/style/:z(\\d+)/:x(\\d+)/:y(\\d+).grid.json', middleware.style, cors(), grid);

app.get('/source/:z(\\d+)/:x(\\d+)/:y(\\d+).:format([\\w\\.]+)', middleware.source, cors(), tile);

app.get('/style/:z(\\d+)/:x(\\d+)/:y(\\d+).:format([\\w\\.]+)', middleware.style, cors(), tile);

app.get('/style/:z(\\d+)/:x(\\d+)/:y(\\d+):scale(@\\d+x).:format([\\w\\.]+)', middleware.style, cors(), tile);

app.get('/static/:z,:x,:y/:px(\\d+)x:py(\\d+):scale(@\\d+x).:format([\\w\\.]+)', middleware.style, cors(), printFromCenter);

app.get('/static/:z/:w,:s,:e,:n:scale(@\\d+x).:format([\\w\\.]+)', middleware.style, cors(), printFromBbox);

app.get('/source/:z,:lon,:lat.json', middleware.source, cors(), inspect);

app.get('/testelev/:z,:lon,:lat.json', middleware.source, cors(), findElevation);

app.get('/contours/:z,:lon,:lat.json', middleware.source, cors(), getContours);

app.get('/poly/:poly,:density.json', middleware.source, cors(), decodePoly);

app.get('/style/:z,:lon,:lat.json', middleware.style, cors(), inspect);


function decodePoly(req,res,next) {

    var startTime = new Date();
    var decodedPoly = polyline.decode(req.params.poly);
    var density = parseInt(req.params.density, 10);
    var tolerance = 1;
    var returnData = [];
    var qCounter = 0;
    //return res.json({pts:decodedPoly,density:density});
    function queryDone() {
        if (returnData.length == decodedPoly.length) {
            return res.json({output:returnData,responseTime:new Date()-startTime});
        }
        else {
            getElev(z,decodedPoly[qCounter])
        }
    }
    function getElev(z,lonlat) {
        var lon = lonlat[1];
        var lat = lonlat[0];

        req.style.queryTile(z, lon, lat, { layer: 'contour', tolerance:tolerance }, function(err, data, headers) {
            if (err) {
                console.error(err);
                return next(err);
            }
            //res.set(headers);

            data.sort(function(a, b) {
                var ad = a.distance || 0;
                var bd = b.distance || 0;
                return ad < bd ? -1 : ad > bd ? 1 : 0;
            });

            if (data.length<1){
                var elevationOutput = {
                    distance: -999,//conData[1].distance,
                    lat: lat,
                    lon: lon,
                    elevation: -999,
                    tolerance: tolerance
                }
            }

            else if (data.length==1){
                var elevationOutput = {
                    distance: data[0].distance,//conData[1].distance,
                    lat: lat,
                    lon: lon,
                    elevation: data[0].attributes.ele,
                    tolerance: tolerance
                }
            }
            else {
                var distRatio = data[1].distance/(data[0].distance+data[1].distance);
                var heightDiff = (data[0].attributes.ele-data[1].attributes.ele);
                var calcEle = data[1].attributes.ele+heightDiff*distRatio;

                var elevationOutput = {
                    distance: (data[0].distance+data[1].distance)/2,//conData[1].distance,
                    lat: lat,
                    lon: lon,
                    elevation: calcEle,
                    tolerance: tolerance
                }
            }
            qCounter+=1;
            returnData.push(elevationOutput);
            queryDone();
            //return res.json({out:elevationOutput});

            
        });
    }
    var z = 14;
    getElev(z,decodedPoly[qCounter]);
}

function getContours(req,res,next) {
    var startTime = new Date();
    var lon = parseFloat(req.params.lon);
    var lat = parseFloat(req.params.lat);
    var z = parseInt(req.params.z, 10);

    var merc = new sm();
    var dists = [];
    var xyz = merc.xyz([lon,lat,lon,lat],z);
    var bbox = merc.bbox(xyz.minX, xyz.minY,z)
    var extentJSON = {
        features: [
            {
                geometry: {
                    coordinates: [
                        [bbox[0],bbox[1]],
                        [bbox[0],bbox[3]],
                        [bbox[2],bbox[3]],
                        [bbox[2],bbox[1]],
                        [bbox[0],bbox[1]]
                    ]
                },
                properties: {
                    has_contours:  true
                }
            }
        ]
    }

    req.style._backend.getTile(z, xyz.minX, xyz.minY, function(err, vtile, headers) {
        if (err) return next(err);
        
        try {
            var outJSON = vtile.toGeoJSON('contour') || { type: 'FeatureCollection', features: [], name: 'contour' };
            extentJSON.features[0].properties.contours = outJSON.features.length;
        }
        catch(e) {
            extentJSON.features[0].properties.contours = 0;
            var outJSON = {}
        }

        var searchTime = new Date()-startTime;
        //
        return res.json({features:outJSON,zxy:''+z+','+xyz.minX+','+xyz.minY}); 
    });

}


function findElevation(req,res,next){

    var lon = parseFloat(req.params.lon);
    var lat = parseFloat(req.params.lat);
    var z = parseInt(req.params.z, 10);

    var tolerance = 1000;

    req.style.queryTile(z, lon, lat, { layer: 'contour', tolerance:tolerance }, function(err, data, headers) {
        if (err) return next(err);
        res.set(headers);

        data.sort(function(a, b) {
            var ad = a.distance || 0;
            var bd = b.distance || 0;
            return ad < bd ? -1 : ad > bd ? 1 : 0;
        });

        if (data.length<1){
            var elevationOutput = {
                distance: -999,//conData[1].distance,
                lat: lat,
                lon: lon,
                elevation: -999,
                tolerance: tolerance
            }

        }

        else {
            try{
                var elevationOutput = {
                    distance: data[0].distance,//conData[1].distance,
                    lat: lat,
                    lon: lon,
                    elevation: data[0].attributes.ele,
                    tolerance: tolerance
                }
            }
            catch(err) {
                var elevationOutput = {
                    distanceBetween: -999,
                    lat: lat,
                    lon: lon,
                    elevation: -999
                }
            }
        }
        return res.json({out:elevationOutput});

        
    });
}
function testElevation(req,res,next) {
    var startTime = new Date();
    var lon = parseFloat(req.params.lon);
    var lat = parseFloat(req.params.lat);
    var z = parseInt(req.params.z, 10);
    var xOff = 0;
    var yOff = 0;

    var tolerance = 6500;

    var merc = new sm();
    var xyz = merc.xyz([lon,lat,lon,lat],z);
    

    req.style._backend.getTile(z, xyz.minX, xyz.minY, function(err, vtile, headers) {
        if (err) return next(err);

        var outJson = vtile.toGeoJSON("contour");
        console.log("PREFIX: "+lon+" "+lat);
        if (outJson.features.length == 0) {
            var tbox = merc.bbox(xyz.minX, xyz.minY,z);
            var ctr = {};
            ctr.lon = (tbox[0]+tbox[2])/2+tbox[2];
            ctr.lat = (tbox[1]+tbox[3])/2+tbox[3];
            var xOff,
                yOff;
            if (lon<ctr.lon && lat < ctr.lat) {
                var xOff = -1;
                var yOff = -1;
                var newbox = merc.bbox(xyz.minX-1, xyz.minY-1,z);
                lon = newbox[2];
                lat = newbox[3];
            }
            else if (lon<ctr.lon && lat > ctr.lat) {
                var xOff = -1;
                var yOff = 1;
                var newbox = merc.bbox(xyz.minX-1, xyz.minY+1,z);
                lon = newbox[2];
                lat = newbox[1];
            }
            else if (lon>ctr.lon && lat < ctr.lat) {
                var xOff = 1;
                var yOff = -1;
                var newbox = merc.bbox(xyz.minX+1, xyz.minY-1,z);
                lon = newbox[0];
                lat = newbox[3];
            }
            else {
                var xOff = 1;
                var yOff = 1;
                var newbox = merc.bbox(xyz.minX+1, xyz.minY+1,z);
                lon = newbox[0];
                lat = newbox[1];
            }
            console.log("FIX: "+lon+" "+lat);

        }

        req.style.queryTile(z, lon, lat, { layer: 'contour', tolerance:tolerance }, function(err, data, headers) {
            if (err) return next(err);
            res.set(headers);
            console.log("ff:"+xOff);
            data.sort(function(a, b) {
                var ad = a.distance || 0;
                var bd = b.distance || 0;
                return ad < bd ? -1 : ad > bd ? 1 : 0;
            });

            var elevationOutput = {
                distance: data[0].distance,//conData[1].distance,
                lat: lat,
                lon: lon,
                elevation: data[0].attributes.ele,
                tolerance: tolerance
            }

            return res.json({out:elevationOutput,data:outJson});

        }); 
    });
}

function inspect(req, res, next) {
    var lon = parseFloat(req.params.lon);
    var lat = parseFloat(req.params.lat);
    var z = parseInt(req.params.z, 10);

    // Tolerance at z0.
    var tolerance = Math.round(20037508.34 / 32 / Math.pow(2,z));

    req.style.queryTile(z, lon, lat, { tolerance:tolerance }, function(err, data, headers) {
        if (err) return next(err);
        res.set(headers);
        data.sort(function(a, b) {
            var ad = a.distance || 0;
            var bd = b.distance || 0;
            return ad < bd ? -1 : ad > bd ? 1 : 0;
        });
        data = data.reduce(function(memo, feature) {
            memo[feature.layer] = memo[feature.layer] || [];
            memo[feature.layer].push(feature);
            return memo;
        }, {});
        return res.json(data);
    });
}

function grid(req, res, next) {
    var z = req.params.z | 0;
    var x = req.params.x | 0;
    var y = req.params.y | 0;
    req.style.getGrid(z,x,y, function(err, data, headers) {
        if (err && err.message === 'Tilesource not loaded') {
            return res.redirect(req.path);
        } else if (err) {
            return next(err);
        }
        headers['cache-control'] = 'max-age=3600';
        res.set(headers);
        return res.json(data);
    });
}

function tile(req, res, next) {
    var z = req.params.z | 0;
    var x = req.params.x | 0;
    var y = req.params.y | 0;
    var scale = (req.params.scale) ? req.params.scale[1] | 0 : undefined;
    // limits scale to 4x (1024 x 1024 tiles or 288dpi) for now
    scale = scale > 4 ? 4 : scale;

    var id = req.source ? req.source.data.id : req.style.data.id;
    var source = req.params.format === 'vector.pbf'
        ? req.style._backend._source
        : req.style;
    var done = function(err, data, headers) {
        if (err && err.message === 'Tilesource not loaded') {
            return res.redirect(req.path);
        } else if (err) {
            // Set errors cookie for this style.
            style.error(id, err);
            res.cookie('errors', _(style.error(id)).join('|'));
            return next(err);
        }

        // Set drawtime cookie for a given style.
        style.stats(id, 'drawtime', z, data._drawtime);
        res.cookie('drawtime', _(style.stats(id, 'drawtime'))
            .reduce(function(memo, stat, z) {
                memo.push([z,stat.min,stat.avg|0,stat.max].join('-'));
                return memo;
            }, []).join('.'));

        // Set srcbytes cookie for a given style.
        style.stats(id, 'srcbytes', z, data._srcbytes);
        res.cookie('srcbytes', _(style.stats(id, 'srcbytes')).
            reduce(function(memo, stat, z) {
                memo.push([z,stat.min,stat.avg|0,stat.max].join('-'));
                return memo;
            }, []).join('.'));

        // Clear out tile errors.
        res.cookie('errors', '');

        // If debug flag is set, reduce json data.
        if (done.format === 'json' && 'debug' in req.query) {
            data = _(data).reduce(function(memo, layer) {
                memo[layer.name] = {
                    features: layer.features.length,
                    jsonsize: JSON.stringify(layer).length
                };
                return memo;
            }, {});
        }

        headers['cache-control'] = 'max-age=3600';
        if (req.params.format === 'vector.pbf') {
            headers['content-encoding'] = 'deflate';
        }
        res.set(headers);
        return res.send(data);
    };
    done.scale = scale;
    if (req.params.format !== 'png') done.format = req.params.format;
    source.getTile(z,x,y, done);
}

function printFromCenter(req, res, next){
    // x & y are lng,lat at the center of the map
    var params = {};
    params.zoom = req.params.z | 0;
    params.center = {
        x: parseFloat(req.params.x),
        y: parseFloat(req.params.y),
        w: req.params.px | 0,
        h: req.params.py | 0
    };

    params.scale = (req.params.scale) ? req.params.scale[1] | 0 : undefined;
    params.scale = params.scale > 4 ? 4 : params.scale;
    params.format = (req.params.format !== 'png') ? req.params.format : 'png';

    var source = req.params.format === 'vector.pbf'
        ? req.style._backend._source
        : req.style;

    params.getTile = source.getTile.bind(source);
    printer(params, function(err, image, header){
        if (err) return next(err);
        _(header).each(function(v, k) {
            res.set(k, v);
        });
        return res.send(image);
    });
};

function printFromBbox(req, res, next){
    // bbox is [w,s,e,n] boundaries for rectangle
    var params = {};
    params.zoom = req.params.z | 0;
    params.bbox = [req.params.w, req.params.s, req.params.e, req.params.n]
    params.scale = (req.params.scale) ? req.params.scale[1] | 0 : undefined;
    params.scale = params.scale > 4 ? 4 : params.scale;
    params.format = (req.params.format !== 'png') ? req.params.format : 'png';

    var source = req.params.format === 'vector.pbf'
        ? req.style._backend._source
        : req.style;

    params.getTile = source.getTile.bind(source);
    printer(params, function(err, image, header){
        if (err) return next(err);
        _(header).each(function(v, k) {
            res.set(k, v);
        });
        return res.send(image);
    });
}

app.get('/style.xml', middleware.style, function(req, res, next) {
    res.set({'content-type':'text/xml'});
    return res.send(req.style._xml);
});

app.get('/style.tm2z', middleware.style, function(req, res, next) {
    style.toPackage(req.style.data.id, res, function(err) {
        if (err) next(err);
        res.end();
    });
});

app.get('/upload', middleware.auth, function(req, res, next) {
    if (style.tmpid(req.query.styleid))
        return next(new Error('Style must be saved first'));

    style.upload({
        id: req.query.styleid,
        oauth: tm.db.get('oauth'),
        cache: tm.config().cache
    }, function(err){
        if (err) next(err);
        res.end();
    });
});

app.get('/source.xml', middleware.source, function(req, res, next) {
    res.set({'content-type':'text/xml'});
    return res.send(req.source._xml);
});

app.get('/source.mbtiles', middleware.source, function(req, res, next) {
    res.set({'content-type':'text/xml'});
    source.toMBTiles(req.source.data.id, res, function(err) {
        if (err) next(err);
        res.end();
    });
});

app.all('/mbtiles', function(req, res, next) {
    source.info(req.query.id, function(err, info) {
        if (err) return next(err);
        source.mbtiles(req.query.id, false, function(err, job) {
            if (err) return next(err);
            if (/application\/json/.test(req.headers.accept||'')) {
                res.send(job);
            } else {
                res.set({'content-type':'text/html'});
                res.send(tm.templates.export({
                    tm: tm,
                    job: job,
                    source: info
                }));
            }
        });
    });
});

app.all('/mbtiles.json', function(req, res, next) {
    if (req.method === 'DELETE') return tm.cleartask(function(err) {
        if (err) return next(err);
        res.send({});
    });
    source.info(req.query.id, function(err, info) {
        if (err) return next(err);
        source.mbtiles(req.query.id, req.method === 'PUT', function(err, job) {
            if (err) return next(err);
            res.send(job);
        });
    });
});

app.get('/source', middleware.source, middleware.history, function(req, res, next) {

    // identify user's OS for styling docs shortcuts
    var agent = function() {
        var agent = req.headers['user-agent'];
        if (agent.indexOf('Win') != -1) return 'windows';
        if (agent.indexOf('Mac') != -1) return 'mac';
        if (agent.indexOf('X11') != -1 || agent.indexOf('Linux') != -1) return 'linux';
        return 'mac'; // default to Mac.
    };

    res.set({'content-type':'text/html'});
    try {
        var page = tm.templates.source({
            tm: tm,
            cwd: config.cwd,
            remote: url.parse(req.query.id).protocol !== 'tmsource:',
            source: req.source.data,
            history: req.history,
            basemap: req.basemap,
            user: tm.db.get('user'),
            test: 'test' in req.query,
            agent: agent()
        });
    } catch(err) {
        return next(new Error('source template: ' + err.message));
    }
    return res.send(page);
});

app.put('/source.json', middleware.writeSource, function(req, res, next) {
    res.send({
        mtime:req.source.data.mtime,
        vector_layers:req.source.data.vector_layers,
        _template:req.source.data._template
    });
});

app.get('/source.json', middleware.source, function(req, res, next) {
    res.send(req.source.data);
});

app.get('/browse*', function(req, res, next) {
    tm.dirfiles('/' + req.params[0], function(err, dirfiles) {
        if (err) return next(err);
        res.send(dirfiles);
    });
});

app.get('/thumb.png', function(req, res, next) {
    if (!req.query.id) return next(new Error('No id specified'));
    style.thumb(req.query.id, function(err, thumb) {
        if (err && err.message === 'Tile does not exist') {
            return res.send(err.toString(), 404);
        } else if (err) {
            return next(err);
        }
        var headers = {};
        headers['cache-control'] = 'max-age=3600';
        headers['content-type'] = 'image/png';
        res.set(headers);
        res.send(thumb);
    });
});

app.get('/font.png', function(req, res, next) {
    if (!req.query.id) return next(new Error('No id specified'));
    tm.font(req.query.id, function(err, buffer) {
        if (err) return next(err);
        var headers = {};
        headers['cache-control'] = 'max-age=3600';
        headers['content-type'] = 'image/png';
        res.set(headers);
        res.send(buffer);
    });
});

app.get('/app/cartoref.js', function(req, res, next) {
    res.set({
        'content-type':'application/javascript',
        'cache-control':'max-age=3600'
    });
    res.send('window.cartoRef = ' + JSON.stringify(require('carto').tree.Reference.data) + ';');
});

app.get('/new/style', middleware.exporting, middleware.writeStyle, function(req, res) {
    res.redirect('/style?id=' + req.style.data.id);
});

app.get('/new/source', middleware.exporting, middleware.writeSource, function(req, res, next) {
    res.redirect('/source?id=' + req.source.data.id + '#addlayer');
});

app.get('/', function(req, res, next) {
    res.redirect('/new/style');
});

app.get('/history.json', middleware.userTilesets, middleware.history, function(req, res, next) {
    res.send(req.history);
});

app.del('/history/:type(style|source)', function(req, res, next) {
    if (!req.query.id) return next(new Error('No id specified'));
    tm.history(req.params.type,req.query.id, true);
    res.send(200);
});

app.use(function(err, req, res, next) {
    console.error(err.stack);

    // Error on loading a tile, send 404.
    if (err && req.params && 'z' in req.params) return res.send(err.toString(), 404);
    if (err && err.status === 401) return res.redirect('/unauthorize');


    // Otherwise 500 for now.
    if (/application\/json/.test(req.headers.accept)) {
        res.set({'content-type':'application/javascript'});
        res.send({
            message: err.message,
            code: err.code
        }, 500);
    } else if (/text\/html/.test(req.headers.accept)) {
        res.send(tm.templates.error({ error:err }), 500);
    } else {
        res.send(err.toString(), 500);
    }
});

app.get('/geocode', middleware.auth, middleware.basemap, function(req, res, next) {
    var query = 'http://api.tiles.mapbox.com/v3/'+req.basemap.id+'/geocode/{query}.json';
    res.redirect(query.replace('{query}', req.query.search));
});

//Calls mapnik-omnivore for file's metadata
app.get('/metadata', function(req, res, next) {
    mapnik_omnivore.digest(req.query.file, function(err, metadata){
        if(err) return next(err);
        res.send(metadata);
    });
});


// Include mock mapbox API routes if in test mode.
if (config.test) require('./lib/mapbox-mock')(app);

app.listen(config.port);
console.log('TM2 @ http://localhost:'+config.port+'/');
