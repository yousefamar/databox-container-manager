var Promise = require('promise');
var Config = require('./config.json');
var ursa = require('ursa');
var os = require('os');
var crypto = require('crypto');
var request = require('request');

var db = require('./include/container-manager-db.js');

var dockerHelper = require('./include/container-manager-docker-helper.js');

var docker = dockerHelper.getDocker();

var ip = '127.0.0.1';

//ARCH to append -amd to the end of a container name if running on arm
var ARCH = '';
if(process.arch == 'arm'){
  ARCH = '-arm';
} 


exports.connect  = function () {
  return new Promise( (resolve, reject) => docker.ping(function (err,data) {
    if(err) reject("Cant connect to docker!");
    resolve();
  }));
}

exports.getDockerEmitter = function () {
  return dockerHelper.getDockerEmitter();
}

var listContainers = function(){
  return new Promise( (resolve, reject) =>  {
    docker.listContainers({all: true, filters: { "label": [ "databox.type" ] }},
        (err, containers) => {
          if(err) {
            reject(err);
            return;
          }
          resolve(containers);
        }
      );

  });
}
exports.listContainers = listContainers;


exports.killAll = function () {
  return new Promise( (resolve, reject) =>  {
    listContainers()
      .then(containers => {
        ids = []
        for(var i in containers) {
          var e = containers[i];
          console.log("killing " + e.Image + " id=" + e.Id + " ...");
          ids.push(dockerHelper.kill(e.Id));
          console.log("removing " + e.Image + " id=" + e.Id + " ...");
          ids.push(dockerHelper.remove(e.Id));
        };
        return Promise.all(ids)
      })
      .then((data) => {resolve()})
      .catch(err => {consol.log("[killAll-2]" + err); reject(err)})
  });
}

var getContainer = function(id) {
  return new Promise( (resolve, reject) =>  {
    resolve(docker.getContainer(id));
  });
}
exports.getContainer = getContainer;

exports.initNetworks = function () {
  return new Promise( (resolve, reject) =>  {
      console.log('initNetworks');
      dockerHelper.listNetworks()
        .then(networks => {
          var requiredNets =  [
                      dockerHelper.getNetwork(networks,'databox-driver-net'),
                      dockerHelper.getNetwork(networks,'databox-app-net')
                    ]

          return Promise.all(requiredNets)
              .then((networks) => {
                console.log("Networks already exist");
                //console.log(networks);
                resolve(networks);
              })
              .catch(err => {
                console.log("initNetworks::"+err);
                reject(err);
              })

        })
        .then( (networks) => {
          resolve(networks)
        });
    })
    .catch(err => reject(err))
  };


var pullImage = function (imageName) {
	return new Promise((resolve, reject) => {
		//Pull latest Arbiter image
		console.log('Pulling ' + imageName);
		docker.pull(Config.registryUrl + "/" + imageName, (err, stream) => {
			if (err) {
				reject(err);
				return;
			}

			stream.pipe(process.stdout);
			docker.modem.followProgress(stream, (err, output) => {
				if (err) {
					reject(err);
					return;
				}
        resolve(";->");
			});
		})
	});
};
exports.pullImage = pullImage;

var keyPair = null;
var generatingCMkeyPair = function () {
return new Promise( (resolve, reject) =>  {
      //Generating CM Key Pair
      console.log('Generating CM key pair');
      keyPair = ursa.generatePrivateKey();
      var publicKey = keyPair.toPublicPem('base64');
      resolve({'keyPair':keyPair,'publicKey':publicKey});
  });
}

var startContainer = function(cont) {
  return new Promise( (resolve, reject) =>  {
    //TODO: check cont
    cont.start((err ,data) => {
      if(err) {
        reject('startContainer:: '+err);
        return;
      }
       dockerHelper.inspectContainer(cont)
      .then( (info) => {
        var name = repoTagToName(info.Name);
        console.log("updateSLAContainerRunningState:: to true" + name);
        db.updateSLAContainerRunningState(name,true)
        .then(resolve(cont))
        .catch((err) => reject(err));
      })
    })
  });
}
exports.startContainer = startContainer;

exports.stopContainer = function(cont) {
  return new Promise( (resolve, reject) =>  {
    //TODO: check cont
    cont.stop((err ,data) => {
      if(err && err['statusCode'] != 304) { //don't error if container is already stopped!
        reject(err);
        return;
      }
      dockerHelper.inspectContainer(cont)
      .then( (info) => {
        var name = repoTagToName(info.Name);
        console.log("updateSLAContainerRunningState to false::" + name);
        db.updateSLAContainerRunningState(name,false)
        .then(resolve(cont))
        .catch((err) => reject(err));
      })
      
    })
  });
}

exports.removeContainer = function (cont) {
  console.log(cont);
  return new Promise( (resolve, reject) =>  {
    
    dockerHelper.inspectContainer(cont)
    .then( (info) => {
      cont.remove({force: true},(err,data) => {
        if(err) {
          console.log("[remove]" + err);
          reject(err);
          return;
        } 
        var name = repoTagToName(info.Name);
        console.log("removed " + name + "!");
        console.log("deleteSLA::" + name);
        db.deleteSLA(name,false)
        .then(resolve(cont))
        .catch((err) => reject(err));
      })
    });
  });
}

var arbiterName = '';
exports.launchArbiter = function () {
  return new Promise( (resolve, reject) =>  {
    var name = "databox-arbiter"+ARCH;
    arbiterName = name;
    pullImage(name+":latest")
    .then(() => {return generatingCMkeyPair()})
    .then(keys => {
        //console.log(keys);
        return dockerHelper.createContainer(
              {'name': name,
               'Image': Config.registryUrl + "/"+name+":latest",
               //PortBindings: '8080/tcp': [ HostPort: \8081 ]
               'PublishAllPorts': true,
               'Env': [ "CM_PUB_KEY=" + keys['publicKey'] ]
            }
          );
      })
    .then((Arbiter) => { return startContainer(Arbiter) })
    .then((Arbiter) => {
      console.log("connecting to driver network");
      return dockerHelper.connectToNetwork(Arbiter,'databox-driver-net');
    })
    .then((Arbiter) => {
      console.log("connecting to app network");
      return dockerHelper.connectToNetwork(Arbiter,'databox-app-net');
    })
    .then((Arbiter) => {return dockerHelper.inspectContainer(Arbiter)} )
    .then((data) => { resolve({'name': name, port: parseInt(data.NetworkSettings.Ports['8080/tcp'][0].HostPort) }) })
    .catch((err) => {
      console.log("Error creating Arbiter");
      reject(err)
    });

  });
}

var directoryName = null;
exports.launchDirectory = function () {
  return new Promise( (resolve, reject) =>  {
    var name = "databox-directory"+ARCH;
    directoryName = name;
    pullImage(name+":latest")
    .then(() => {
        return dockerHelper.createContainer(
              {'name': 'directory',
               'Image': Config.registryUrl + "/"+name+":latest",
               'PublishAllPorts': true
            }
          );
      })
    .then((Directory) => { return startContainer(Directory) })
    .then((Directory) => {
      console.log("connecting to driver network");
      return dockerHelper.connectToNetwork(Directory,'databox-driver-net');
    })
    .then((Directory) => {
      console.log("connecting to app network");
      return dockerHelper.connectToNetwork(Directory,'databox-app-net');
    })
    .then((Directory) => {return dockerHelper.inspectContainer(Directory)} )
    .then((data) => { resolve({'name': name, port: parseInt(data.NetworkSettings.Ports['3000/tcp'][0].HostPort) }) })
    .catch((err) => {
      console.log("Error creating Directory");
      reject(err)
    });

  });
}

var repoTagToName = function (repoTag) {
  return repoTag.match(/(?:.*\/)?([^/:\s]+)(?::.*|$)/)[1];
}

var generateArbiterToken = function () {
  return new Promise( (resolve, reject) =>  {
    crypto.randomBytes(32, function (err, buffer) {
      if(err) reject(err);
      var token = buffer.toString('base64');
      resolve(token)
    });
  });
}

var configureDriver = function (cont) {
  return new Promise( (resolve, reject) =>  {
      dockerHelper.connectToNetwork(cont,'databox-driver-net')
      .then(resolve())
      .catch((err) => reject(err))
  });
}

var configureApp = function (cont) {
  return new Promise( (resolve, reject) =>  {
      dockerHelper.connectToNetwork(cont,'databox-app-net')
      .then(resolve())
      .catch((err) => reject(err))
  });
}

var configureStore = function (cont) {
  return new Promise( (resolve, reject) =>  {
      dockerHelper.connectToNetwork(cont,'databox-driver-net')
      .then(resolve())
      .catch((err) => reject(err))
  });
}

var updateArbiter = function(data) {
  return new Promise( (resolve, reject) =>  {
    getContainer(arbiterName)
    .then((Arbiter) => {return dockerHelper.inspectContainer(Arbiter)})
    .then((arbiterInfo) => {
      var port = parseInt(arbiterInfo.NetworkSettings.Ports['8080/tcp'][0].HostPort);
      request.post(
                    { url: "http://localhost:"+port+"/update",
                      form: data
                    }
                    ,
                    function(err, response, body) {
                      if(err) {
                        reject(err);
                        return;
                      }
                      resolve(JSON.parse(body));
                    }
                  )
    })
    .catch((err) => reject(err))
  });
}

var launchContainer = function (repoTag, sla) {
  console.log("launchContainer::",repoTag, sla);
  var env = [];
  var name = repoTagToName(repoTag);
  name = name + ARCH;
  
  var arbiterToken = null;
  var type = null;
  var containerInfo = null;
  var container = null;
  var containerPort = null;
  var containerSLA = sla ? sla : false;
  var SLA_RetrievedFromDB = false;

  return new Promise( (resolve, reject) =>  {

    pullImage(name + ":latest")
    .then( () => {
      //Look for an SLA to use. If one is not provided then, look for one stored in the DB.
      //If no SLA can be found db.getSLA() will reject its promise and stop the container
      //installing.  
      if(containerSLA !== false) {
        return new Promise.resolve(containerSLA);
      }
      //sla not provided look to see if we have one for this container
      SLA_RetrievedFromDB = true; 
      return db.getSLA();
    } )
    .then((sla) => {
      containerSLA = sla;
    })     
    .then(() => {
      console.log("Generating Arbiter token for "+name+" container");
      return generateArbiterToken();
    })
    .then((token) => {
      arbiterToken = token;

      //TODO: Parse containerSLA and set ENV and start dependencies.
      
      return dockerHelper.createContainer(
                              {
                                'name': name,
                                'Image': Config.registryUrl + '/' + name + ARCH +":latest",
                                'Env': [ "DATABOX_IP="+ip, "ARBITER_TOKEN="+token ],
                                'PublishAllPorts': true
                              }
                            );
    })
    .then((cont) => {
      container = cont
      return dockerHelper.inspectContainer(container)
    })
    //.then((info) => {
    //
    //  console.log("Checking ports exposed by #name container");
    //  TODO: this might be needed here!!
    //})
    .then( (info) => {
      type = info.Config.Labels['databox.type'];

      console.log("Passing "+name+" token to Arbiter");

      var update = JSON.stringify({ name:name, token:arbiterToken, type:type });

      var sig = keyPair.hashAndSign('md5', new Buffer(update)).toString('base64');

      return updateArbiter({data:update, sig });

    })
    .then(() => {
      return startContainer(container);
    })
    .then(() => {
      if(type == 'driver') {
        return configureDriver(container);
      } else if(type == 'store') {
        return configureStore(container);
      } else {
        return configureApp(container);
      }
    })
    .then( () => {  
      if(SLA_RetrievedFromDB) {
        return new Promise.resolve();
      } else {
        return db.putSLA(name,containerSLA);} 
      }
    )
    .then( () => {return db.updateSLAContainerRunningState(name,true);} )
    .then( () => { return getContainer(name)})
    .then((cont) => { return dockerHelper.inspectContainer(cont) })
    .then( (info) => {
      containerInfo = info;
      containerPort = parseInt(info.NetworkSettings.Ports['8080/tcp'][0].HostPort);
      console.log("Container " + name + " launched");
      resolve({name:name, port:containerPort})
    })
    .catch((err) => {
      console.log("[launchContainer ERROR]" + err);
      reject(err);
    });

  });
}
exports.launchContainer = launchContainer;


exports.restoreContainers = function (slas) {
    
  console.log("Launching " + slas.length + " containers");
  var proms = [];
  for(sla of slas){
    //don't pass the SLA here it make the logic in launchContainer complex 
    proms.push(launchContainer(sla.name));
  }
  return new Promise.all(proms);
}


exports.getActiveSLAs = function() {
  return db.getActiveSLAs();
}