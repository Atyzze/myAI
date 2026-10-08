# The myAI packages, parameterised by which GPU stacks the image carries.
#
#   accelerators   any of "cuda" "rocm" "vulkan" ("igpu" only changes the plan)
#   diarization    false drops torch/speechbrain from the VTS runtime
#
# Everything without "cuda" or "rocm" comes from the NixOS binary cache except
# CTranslate2 (see ctranslate2-cpp below), which compiles in minutes. CUDA also
# builds Ollama from source the first time (unfree, so not in the public
# cache); after that they are in your own store like anything else.
{
  pkgs,
  lib,
  accelerators ? [ "vulkan" ],
  diarization ? true,
  src ? ../.,
}:
let
  has = a: builtins.elem a accelerators;

  # CTranslate2 must link the same OpenBLAS build as torch. nixpkgs builds it
  # against `openblas` while torch uses `blas.provider`, a second build with
  # the same soname: whichever loads first serves both, and the other library
  # then crashes (SIGFPE in sgemm) on the first speaker embedding after a
  # transcription. One BLAS per process; this costs one source build of
  # CTranslate2, which is not in the binary cache with this BLAS.
  ctranslate2-cpp = pkgs.ctranslate2.override (
    {
      openblas = pkgs.blas.provider;
    }
    // lib.optionalAttrs (has "cuda") {
      withCUDA = true;
      withCuDNN = true;
    }
  );

  python = pkgs.python3.override {
    self = python;
    packageOverrides = _final: prev: {
      ctranslate2 = prev.ctranslate2.override { inherit ctranslate2-cpp; };
    };
  };

  vtsPython = python.withPackages (
    ps:
    [
      ps.faster-whisper
      ps.fastapi
      ps.uvicorn
      ps.numpy
      ps.huggingface-hub
    ]
    ++ lib.optionals diarization [
      ps.speechbrain
      ps.hyperpyyaml
      ps.torch
      ps.torchaudio
    ]
  );

  fetchPython = pkgs.python3.withPackages (ps: [ ps.huggingface-hub ]);

  # The calendar server's Python, with vobject patched (vobject-keep-values.patch): vobject 0.9.9
  # cuts a property's value at its first comma when the value is not text, so an iPhone's saved
  # place ("geo:52.37,4.89") would lose its longitude the first time the box stored the event.
  # vobject's and Radicale's own test suites pass with it.
  calendarPython = pkgs.python3.override {
    self = calendarPython;
    packageOverrides = _final: prev: {
      vobject = prev.vobject.overridePythonAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./vobject-keep-values.patch ];
      });
    };
  };

  buildNumber = dir: lib.strings.trim (builtins.readFile (src + "/${dir}/BUILD_NUMBER"));

  ollamaVariants = {
    cpu = pkgs.ollama-cpu;
  }
  // lib.optionalAttrs (has "vulkan") { vulkan = pkgs.ollama-vulkan; }
  // lib.optionalAttrs (has "cuda") { cuda = pkgs.ollama-cuda; }
  // lib.optionalAttrs (has "rocm") { rocm = pkgs.ollama-rocm; };
in
rec {
  # The browser app: static files, served by nginx at the site root.
  client = pkgs.stdenvNoCC.mkDerivation {
    pname = "myai-client";
    version = buildNumber "client";
    src = src + "/client";
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r index.html manifest.webmanifest sw.js assets src BUILD_NUMBER $out/
      runHook postInstall
    '';
  };

  # The calendar app: static files, served by nginx at /calendar/ (calendar.nix).
  calendar = pkgs.stdenvNoCC.mkDerivation {
    pname = "myai-calendar";
    version = buildNumber "calendar";
    src = src + "/calendar";
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r index.html manifest.webmanifest sw.js assets src BUILD_NUMBER $out/
      runHook postInstall
    '';
  };

  # The calendar server (CalDAV), with the patched vobject.
  radicale = pkgs.radicale.override { python3 = calendarPython; };

  # VTS with its runtime. server.py is started unchanged; VTS_SYSTEM_PYTHON=1
  # tells it the interpreter already has every dependency (no .venv).
  vts = pkgs.stdenvNoCC.mkDerivation {
    pname = "vts";
    version = buildNumber "vts";
    src = src + "/vts";
    nativeBuildInputs = [ pkgs.makeWrapper ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/vts $out/bin
      cp server.py BUILD_NUMBER $out/share/vts/
      makeWrapper ${vtsPython}/bin/python $out/bin/vts-server \
        --add-flags $out/share/vts/server.py \
        --set VTS_SYSTEM_PYTHON 1 \
        --set PYTHONDONTWRITEBYTECODE 1
      runHook postInstall
    '';
    passthru = { python = vtsPython; };
    meta.mainProgram = "vts-server";
  };

  probe = pkgs.stdenvNoCC.mkDerivation {
    pname = "myai-probe";
    version = buildNumber "client";
    src = src + "/box";
    buildInputs = [ pkgs.python3 ];
    dontBuild = true;
    installPhase = ''
      install -Dm755 myai_probe.py $out/bin/myai-probe
    '';
    meta.mainProgram = "myai-probe";
  };

  models = pkgs.stdenvNoCC.mkDerivation {
    pname = "myai-models";
    version = buildNumber "client";
    src = src + "/box";
    buildInputs = [ fetchPython ];
    dontBuild = true;
    installPhase = ''
      install -Dm755 myai_models.py $out/bin/myai-models
    '';
    meta.mainProgram = "myai-models";
  };

  # The three-folder tools: the pipeline runner, the feed builder, the email
  # notifier, the backup loop, and the calendar accounts. Standard library only.
  tools = pkgs.stdenvNoCC.mkDerivation {
    pname = "myai-tools";
    version = buildNumber "client";
    src = src + "/box";
    buildInputs = [ pkgs.python3 ];
    dontBuild = true;
    installPhase = ''
      install -Dm755 myai_pipeline.py $out/bin/myai-pipeline
      install -Dm755 myai_feed.py $out/bin/myai-feed
      install -Dm755 myai_notify.py $out/bin/myai-notify
      install -Dm755 myai_backup.py $out/bin/myai-backup
      install -Dm755 myai_calendar.py $out/bin/myai-calendar
    '';
  };

  status = pkgs.writeShellApplication {
    name = "myai-status";
    runtimeInputs = with pkgs; [
      jq
      iproute2
      gawk
      gnused
      coreutils
      systemd
      tailscale
      ncurses
      hostname
    ];
    checkPhase = "";
    text = builtins.readFile (src + "/box/myai-status");
  };

  # One `ollama` that runs the backend myai-probe chose for this machine
  # (MYAI_OLLAMA_BACKEND, from /run/myai/ollama.env) out of the variants the
  # image carries, falling back to the CPU build.
  ollama = pkgs.writeShellApplication {
    name = "ollama";
    checkPhase = "";
    text = ''
      case "''${MYAI_OLLAMA_BACKEND:-cpu}" in
      ${lib.concatStrings (
        lib.mapAttrsToList (name: pkg: ''
          ${name}) exec ${lib.getExe pkg} "$@" ;;
        '') ollamaVariants
      )}
        *) exec ${lib.getExe pkgs.ollama-cpu} "$@" ;;
      esac
    '';
    passthru.variants = ollamaVariants;
  };

  checks = pkgs.runCommand "myai-tests" {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.nodejs
      pkgs.rsync
      pkgs.ffmpeg-headless
    ];
    # The calendar's sync tests run against this box's own Radicale build.
    MYAI_RADICALE_PYTHON = "${calendarPython.withPackages (ps: [ (ps.toPythonModule radicale) ])}/bin/python";
    MYAI_STRICT_TESTS = "1";
  } ''
    export HOME=$TMPDIR
    cp -r ${src}/box ${src}/vts ${src}/client ${src}/calendar ${src}/nix .
    chmod -R u+w .
    (cd box && python3 -m unittest discover -s tests)
    (cd vts && python3 -m unittest discover -s tests)
    (cd client && MYAI_STRICT_TESTS= npm run -s test:unit)
    (cd calendar && npm run -s test:unit && npm run -s test:sync)
    touch $out
  '';
}
