import React, { Component } from 'react';

class App extends Component {
  constructor() {
    super();
    this.state = {
      weather: [],
      isLoaded: false
    };
  }
  
  componentDidMount(){
    fetch("/weather")
      .then(res => res.json())
      .then(
        (result) => {
          this.setState({
            weather: result.weather,
            isLoaded: true
          });
        },
        (error) => {
          console.log("error")
        }
      )
  }
  render() {
    const { isLoaded, weather } = this.state
    
    console.log(humidity)
    if (!isLoaded) {
      return <div>Loading...</div>;
    } else {
      var parsed = JSON.stringify(weather)
      var temp = parsed.substr(9, 4)
      var humidity = parsed.substr(parsed.indexOf("Humidity")+10, 4)
      return (
        <div className="App">
        <header className="App-header">
          <p>
            Baby View
          </p>
          <img src="http://192.168.0.106:5000/video_feed" alt="Sorry no bueno"/>
          </header>
          <body className="App-body">
            <p>Temperature: {temp} F</p>
            <p>Humidity: {humidity}%</p>
          </body>
      </div>
      );
    }
  }
}
export default App;

